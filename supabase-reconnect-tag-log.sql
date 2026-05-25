-- reconnect_tag_log: every tag-restore handled by /api/webhooks/bison-reconnect.
-- Surfaced on /settings (Tag Restore Log) and joined by /api/account-status to
-- compute "reconnected today" for the account-status dashboard.
--
-- Schema matches the insert in
-- src/app/api/webhooks/bison-reconnect/[instance]/route.ts (logReconnect).

create table if not exists reconnect_tag_log (
  id             bigint generated always as identity primary key,
  occurred_at    timestamptz not null default now(),
  instance       text        not null,
  sender_id      bigint,
  sender_email   text,
  tags_restored  integer     not null default 0,
  tags_total     integer     not null default 0,
  status         text        not null,            -- 'ok' | 'skipped' | 'failed'
  error          text
);

create index if not exists reconnect_tag_log_occurred_idx
  on reconnect_tag_log (occurred_at desc);

create index if not exists reconnect_tag_log_instance_sender_idx
  on reconnect_tag_log (instance, sender_id, occurred_at desc);

create index if not exists reconnect_tag_log_status_idx
  on reconnect_tag_log (status, occurred_at desc);
