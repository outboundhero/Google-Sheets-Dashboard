-- Run this in the Supabase SQL Editor (https://supabase.com/dashboard/project/amzeevbpwxpkbpklhvuz/sql)
-- Adds tags column to domains and backfills from existing inboxes

ALTER TABLE deliverability_domains ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

-- Backfill domain tags from existing inbox tags
UPDATE deliverability_domains d
SET tags = (
  SELECT ARRAY(
    SELECT DISTINCT elem->>'name'
    FROM deliverability_inboxes i, jsonb_array_elements(i.tags) AS elem
    WHERE i.domain = d.domain
      AND i.tags IS NOT NULL
      AND jsonb_typeof(i.tags) = 'array'
    ORDER BY 1
  )
);

CREATE INDEX IF NOT EXISTS idx_domains_tags ON deliverability_domains USING GIN(tags);
