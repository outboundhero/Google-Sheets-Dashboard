-- Cross-tag campaign audit: domains attached to campaigns whose client tag
-- doesn't match the domain's own tag (cross-client contamination). Populated by
-- the manual/weekly audit run; read by the dashboard widget. Run in Supabase.
-- Safe (new table, no drops).
create table if not exists cross_tag_audit (
  instance        text not null,
  domain          text not null,
  client_tag      text,                         -- the domain's own client tag
  wrong_campaigns jsonb not null default '[]',  -- [{id,name,status,clientTag,instance}]
  audited_at      timestamptz not null default now(),
  primary key (instance, domain)
);
alter table cross_tag_audit enable row level security;
