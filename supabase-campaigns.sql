-- Run this in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  client_tag TEXT DEFAULT '',
  total_leads INTEGER DEFAULT 0,
  total_leads_contacted INTEGER DEFAULT 0,
  remaining_leads INTEGER DEFAULT 0,
  emails_sent INTEGER DEFAULT 0,
  replied INTEGER DEFAULT 0,
  unique_replies INTEGER DEFAULT 0,
  bounced INTEGER DEFAULT 0,
  opened INTEGER DEFAULT 0,
  unique_opens INTEGER DEFAULT 0,
  interested INTEGER DEFAULT 0,
  unsubscribed INTEGER DEFAULT 0,
  completion_percentage NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
CREATE INDEX IF NOT EXISTS idx_campaigns_client_tag ON campaigns(client_tag);
CREATE INDEX IF NOT EXISTS idx_campaigns_created_at ON campaigns(created_at DESC);
