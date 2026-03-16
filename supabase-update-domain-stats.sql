-- Run this in Supabase SQL Editor
-- Adds aggregated stats columns to domains table + backfills from inbox data

ALTER TABLE deliverability_domains
  ADD COLUMN IF NOT EXISTS total_sent INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_replied INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_bounced INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS outlook_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS google_count INTEGER DEFAULT 0;

-- Backfill from existing inbox data
UPDATE deliverability_domains d SET
  total_sent = sub.sent,
  total_replied = sub.replied,
  total_bounced = sub.bounced,
  outlook_count = sub.outlook,
  google_count = sub.google
FROM (
  SELECT domain,
    COALESCE(SUM(emails_sent_count), 0)::int AS sent,
    COALESCE(SUM(total_replied_count), 0)::int AS replied,
    COALESCE(SUM(bounced_count), 0)::int AS bounced,
    COUNT(*) FILTER (WHERE type ILIKE '%microsoft%' OR type ILIKE '%outlook%')::int AS outlook,
    COUNT(*) FILTER (WHERE type ILIKE '%google%' OR type ILIKE '%gmail%')::int AS google
  FROM deliverability_inboxes
  GROUP BY domain
) sub WHERE d.domain = sub.domain;
