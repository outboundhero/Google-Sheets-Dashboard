-- Replacement system — cancellation queue (5-day vendor-delete grace).
-- When a burnt domain is removed during execution, we DON'T delete it at the
-- provider immediately. We record it here with scheduled_at = now() + 5 days.
-- A later cron (not built yet) reads 'pending' rows past scheduled_at and does
-- the actual provider delete (Inboxing/MilkBox) or appends to a cancel sheet
-- (ScaledMail/cheap). Until that cron exists, NOTHING is ever deleted at a
-- provider — rows just sit here as a record. Safe to run in Supabase.
create table if not exists replacement_cancellations (
  instance     text not null,
  domain       text not null,
  client_tag   text,
  provider     text,          -- inboxing | milkbox | scaledmail | cheap | unknown
  reason       text,
  scheduled_at timestamptz not null,                 -- earliest the vendor-delete may fire
  status       text not null default 'pending',      -- pending | cancelled | sheet | skipped
  created_at   timestamptz not null default now(),
  primary key (instance, domain),
  constraint replacement_cancellations_status_ck
    check (status in ('pending','cancelled','sheet','skipped'))
);
create index if not exists idx_replacement_cancellations_due
  on replacement_cancellations (status, scheduled_at);

alter table replacement_cancellations enable row level security;
