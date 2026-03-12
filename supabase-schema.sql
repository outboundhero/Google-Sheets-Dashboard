-- Run this in the Supabase SQL Editor (https://supabase.com/dashboard/project/amzeevbpwxpkbpklhvuz/sql)

CREATE TABLE IF NOT EXISTS deliverability_domains (
  domain TEXT PRIMARY KEY,
  inbox_count INTEGER DEFAULT 0,
  domain_created_at TIMESTAMPTZ,
  warmup_status TEXT DEFAULT 'open' CHECK (warmup_status IN ('open', 'done')),
  synced_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deliverability_inboxes (
  id INTEGER PRIMARY KEY,
  name TEXT,
  email TEXT NOT NULL,
  domain TEXT NOT NULL REFERENCES deliverability_domains(domain) ON DELETE CASCADE,
  status TEXT DEFAULT 'Connected',
  type TEXT,
  daily_limit INTEGER DEFAULT 0,
  warmup_enabled BOOLEAN DEFAULT FALSE,
  tags JSONB DEFAULT '[]',
  emails_sent_count INTEGER DEFAULT 0,
  total_replied_count INTEGER DEFAULT 0,
  total_opened_count INTEGER DEFAULT 0,
  bounced_count INTEGER DEFAULT 0,
  warmup_score INTEGER,
  warmup_daily_limit INTEGER,
  warmup_emails_sent INTEGER,
  warmup_replies_received INTEGER,
  warmup_emails_saved_from_spam INTEGER,
  warmup_bounces_received_count INTEGER,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inboxes_domain ON deliverability_inboxes(domain);
CREATE INDEX IF NOT EXISTS idx_inboxes_tags ON deliverability_inboxes USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_inboxes_status ON deliverability_inboxes(status);
