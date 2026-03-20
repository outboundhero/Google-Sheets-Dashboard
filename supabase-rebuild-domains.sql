-- Run this in Supabase SQL Editor to create the rebuild function
-- DROP the old one first, then create fresh

DROP FUNCTION IF EXISTS rebuild_domain_stats();

CREATE OR REPLACE FUNCTION rebuild_domain_stats()
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  updated_count INTEGER;
  total_inboxes INTEGER;
BEGIN
  SELECT COUNT(*) INTO total_inboxes FROM deliverability_inboxes;

  WITH domain_stats AS (
    SELECT
      i.domain AS d_domain,
      COUNT(*) AS d_inbox_count,
      MIN(i.created_at) AS d_created_at,
      COALESCE(SUM(i.emails_sent_count), 0) AS d_sent,
      COALESCE(SUM(i.total_replied_count), 0) AS d_replied,
      COALESCE(SUM(i.bounced_count), 0) AS d_bounced,
      COUNT(*) FILTER (WHERE i.type ~* 'microsoft|outlook') AS d_outlook,
      COUNT(*) FILTER (WHERE i.type ~* 'google|gmail') AS d_google,
      ARRAY(
        SELECT DISTINCT elem->>'name'
        FROM deliverability_inboxes i2,
             jsonb_array_elements(i2.tags) AS elem
        WHERE i2.domain = i.domain
          AND i2.tags IS NOT NULL
          AND jsonb_typeof(i2.tags) = 'array'
        ORDER BY 1
      ) AS d_tags
    FROM deliverability_inboxes i
    GROUP BY i.domain
  )
  INSERT INTO deliverability_domains (domain, inbox_count, domain_created_at, total_sent, total_replied, total_bounced, outlook_count, google_count, tags, synced_at)
  SELECT d_domain, d_inbox_count, d_created_at, d_sent, d_replied, d_bounced, d_outlook, d_google, d_tags, NOW()
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

  DELETE FROM deliverability_domains
  WHERE domain NOT IN (SELECT DISTINCT domain FROM deliverability_inboxes);

  RETURN json_build_object('domains', updated_count, 'inboxes', total_inboxes);
END;
$$;
