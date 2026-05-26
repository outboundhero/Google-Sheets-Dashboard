-- conform_tag_events: append-only log of every (sender, tag) attempt by
-- /api/deliverability/conform-tags. Lets you audit later which senders got
-- which tags applied, when, by whom, and whether each attempt succeeded.
--
-- One row per (sender, tag) pair within a single apply run, plus a shared
-- batch_id so all events from one click of "Apply" can be grouped.

create table if not exists conform_tag_events (
  id            bigint generated always as identity primary key,
  applied_at    timestamptz not null default now(),
  batch_id      uuid        not null,
  instance      text        not null,
  sender_id     bigint      not null,
  sender_email  text,
  domain        text,
  tag_id        bigint,
  tag_name      text        not null,
  status        text        not null,   -- 'ok' | 'failed'
  error         text
);

create index if not exists conform_tag_events_applied_idx
  on conform_tag_events (applied_at desc);

create index if not exists conform_tag_events_batch_idx
  on conform_tag_events (batch_id);

create index if not exists conform_tag_events_instance_sender_idx
  on conform_tag_events (instance, sender_id, applied_at desc);

create index if not exists conform_tag_events_status_idx
  on conform_tag_events (status, applied_at desc);
