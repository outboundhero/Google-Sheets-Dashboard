-- Run this in the Supabase SQL Editor (https://supabase.com/dashboard/project/amzeevbpwxpkbpklhvuz/sql)
-- Adds a function to return all unique inbox tag names

CREATE OR REPLACE FUNCTION get_unique_inbox_tags()
RETURNS TABLE(tag_name text) LANGUAGE sql STABLE AS $$
  SELECT DISTINCT elem->>'name'
  FROM deliverability_inboxes, jsonb_array_elements(tags) AS elem
  WHERE tags IS NOT NULL AND jsonb_typeof(tags) = 'array'
  ORDER BY 1;
$$;
