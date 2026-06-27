-- Duplicate-domain cleanup: when a domain exists in 2+ instances, the user
-- removes its senders from campaigns on the chosen instance(s) now, and the
-- domain/senders are scheduled for deletion from that instance after a grace
-- period (Spencer: 4 days). A cron fires the actual delete later. Run in
-- Supabase. Safe (new table, no drops).
create table if not exists duplicate_domain_deletions (
  instance     text not null,
  domain       text not null,
  scheduled_at timestamptz not null,           -- when the delete may fire (now + grace)
  status       text not null default 'pending',-- pending | done | cancelled
  created_at   timestamptz not null default now(),
  primary key (instance, domain)
);
alter table duplicate_domain_deletions enable row level security;
