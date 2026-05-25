-- disconnect_events: one row per sender disconnection caught by the Bison webhook.
-- Reconnections live in `reconnect_tag_log` (already exists, populated by the
-- existing /api/webhooks/bison-reconnect handler).
--
-- The daily account-status report joins these two tables to compute:
--   disconnected = events here in the day
--   reconnected  = events here joined with reconnect_tag_log on (instance, sender_id)
--                  where reconnect occurred on the same day after the disconnect
--   failed       = disconnected - reconnected

create table if not exists disconnect_events (
  id            bigint generated always as identity primary key,
  instance      text        not null,
  sender_id     bigint      not null,
  sender_email  text,
  sender_name   text,
  detected_at   timestamptz not null default now(),
  raw_payload   jsonb       -- keep the raw Bison payload for audit/debug
);

create index if not exists disconnect_events_detected_idx
  on disconnect_events (detected_at desc);

create index if not exists disconnect_events_instance_detected_idx
  on disconnect_events (instance, detected_at desc);

create index if not exists disconnect_events_sender_idx
  on disconnect_events (instance, sender_id, detected_at desc);
