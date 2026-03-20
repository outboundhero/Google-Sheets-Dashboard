-- Run this in Supabase SQL Editor to create the rebuild function
-- This function aggregates all inbox stats into domain rows in one efficient SQL operation

CREATE OR REPLACE FUNCTION rebuild_domain_stats()
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  updated_count INTEGER;
  inbox_count INTEGER;
BEGIN
  -- Get total inbox count
  SELECT COUNT(*) INTO inbox_count FROM deliverability_inboxes;

  -- Upsert aggregated domain stats from all inboxes
  WITH domain_stats AS (
    SELECT
      i.domain,
      COUNT(*) AS inbox_count,
      MIN(i.created_at) AS domain_created_at,
      COALESCE(SUM(i.emails_sent_count), 0) AS total_sent,
      COALESCE(SUM(i.total_replied_count), 0) AS total_replied,
      COALESCE(SUM(i.bounced_count), 0) AS total_bounced,
      COUNT(*) FILTER (WHERE i.type ~* 'microsoft|outlook') AS outlook_count,
      COUNT(*) FILTER (WHERE i.type ~* 'google|gmail') AS google_count,
      ARRAY(
        SELECT DISTINCT elem->>'name'
        FROM deliverability_inboxes i2,
             jsonb_array_elements(i2.tags) AS elem
        WHERE i2.domain = i.domain
          AND i2.tags IS NOT NULL
          AND jsonb_typeof(i2.tags) = 'array'
        ORDER BY 1
      ) AS tags,
      NOW() AS synced_at
    FROM deliverability_inboxes i
    GROUP BY i.domain
  )
  INSERT INTO deliverability_domains (domain, inbox_count, domain_created_at, total_sent, total_replied, total_bounced, outlook_count, google_count, tags, synced_at)
  SELECT domain, inbox_count, domain_created_at, total_sent, total_replied, total_bounced, outlook_count, google_count, tags, synced_at
  FROM domain_stats
  ON CONFLICT (domain) DO UPDATE SET
    inbox_count = EXCLUDED.inbox_count,
    total_sent = EXCLUDED.total_sent,
    total_replied = EXCLUDED.total_replied,
    total_bounced = EXCLUDED.total_bounced,
    outlook_count = EXCLUDED.outlook_count,
    google_count = EXCLUDED.google_count,
    tags = EXCLUDED.tags,
    synced_at = EXCLUDED.synced_at;

  GET DIAGNOSTICS updated_count = ROW_COUNT;

  -- Delete domains that have no inboxes
  DELETE FROM deliverability_domains
  WHERE domain NOT IN (SELECT DISTINCT domain FROM deliverability_inboxes);

  RETURN json_build_object('domains', updated_count, 'inboxes', inbox_count);
END;
$$;
