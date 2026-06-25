-- Redirect audit decisions — records Spencer's approve(fix)/disapprove(ignore)
-- choices so a resolved domain stops re-appearing on the dashboard. Run in
-- Supabase SQL editor. Safe (new table, no drops).
create table if not exists redirect_audit_decisions (
  instance     text not null,
  domain       text not null,
  decision     text not null,          -- 'fixed' (redirect corrected) | 'ignored' (left as-is)
  expected_url text,                    -- the URL it was/should be set to
  decided_at   timestamptz not null default now(),
  primary key (instance, domain),
  constraint redirect_audit_decisions_ck check (decision in ('fixed', 'ignored'))
);
alter table redirect_audit_decisions enable row level security;
