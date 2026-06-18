-- =============================================================================
-- Automated Domain Allocation & Replacement System — foundation schema
-- =============================================================================
-- All NEW tables — nothing existing is altered. Safe to run in Supabase SQL
-- editor. The system reads/writes these via the service-role admin client
-- (getSupabaseAdmin), which bypasses RLS; RLS is enabled with no policies so
-- the anon/browser key cannot read them.
--
-- Phase 0 deliverable: config (guardrails, redirect map, campaign map) +
-- reserve/domain lifecycle state (sidecar — does NOT touch deliverability_domains)
-- + an audit/events log. Everything defaults to OBSERVE-ONLY; no automation runs
-- until `replacement_settings.mode` is changed.
-- =============================================================================

-- 1) Guardrail settings (single row, id = 1). Admin-editable thresholds that
--    define when a domain is considered "burnt". Defaults are conservative and
--    observe-only.
create table if not exists replacement_settings (
  id              int primary key default 1,
  mode            text not null default 'observe',   -- 'observe' | 'confirm' | 'auto'
  -- detection thresholds
  min_reply_rate  numeric,        -- flag if reply rate is BELOW this (%), null = ignore signal
  max_bounce_rate numeric,        -- flag if bounce rate is ABOVE this (%), null = ignore signal
  flag_on_surbl   boolean not null default true,     -- SURBL listed counts as a signal
  flag_on_spamhaus boolean not null default true,    -- Spamhaus DBL listed counts as a signal
  min_signals     int not null default 2,            -- how many signals must be true at once
  lookback_window text not null default '30',        -- which rate to use: '10' | '15' | '30' | 'all'
  min_sent        int not null default 50,           -- ignore domains with fewer total sends
  updated_at      timestamptz not null default now(),
  constraint replacement_settings_singleton check (id = 1),
  constraint replacement_settings_mode_ck check (mode in ('observe','confirm','auto'))
);
insert into replacement_settings (id, mode, min_reply_rate, max_bounce_rate)
  values (1, 'observe', 1.0, 5.0)
  on conflict (id) do nothing;

-- 2) client_tag -> redirect URL. Drives Step 3 (set redirect before campaign).
--    source: 'derived' (from live domain redirects), 'sheet', or 'manual'.
create table if not exists client_redirects (
  client_tag   text primary key,         -- UPPERCASE
  redirect_url text not null,
  source       text not null default 'manual',
  updated_at   timestamptz not null default now()
);

-- 3) client_tag -> campaign, per Bison instance. Drives Step 4 (attach to the
--    right campaign in the right instance). `confirmed` lets an admin approve
--    auto-derived candidates before they're used by automation.
create table if not exists client_campaign_map (
  client_tag    text not null,           -- UPPERCASE
  instance      text not null,           -- bison slug: outboundhero | cleaningoutbound | facilityreach | outboundclean
  campaign_id   bigint not null,
  campaign_name text,
  confirmed     boolean not null default false,
  updated_at    timestamptz not null default now(),
  primary key (client_tag, instance, campaign_id)
);

-- 4) Domain lifecycle (sidecar; keyed like the rest of the system by
--    (instance, domain)). Tracks reserve/assignment/flag state WITHOUT touching
--    deliverability_domains.
create table if not exists domain_replacement_state (
  instance           text not null,
  domain             text not null,
  state              text not null default 'reserve',  -- reserve|assigned|flagged|replacing|removed|retired
  assigned_client_tag text,
  flagged_at         timestamptz,
  flagged_reason     text,
  updated_at         timestamptz not null default now(),
  primary key (instance, domain),
  constraint domain_replacement_state_state_ck
    check (state in ('reserve','assigned','flagged','replacing','removed','retired'))
);

-- 5) Audit / events log. Every detection and every action (proposed or executed)
--    lands here — this is also the observe-only output the team audits before
--    enabling automation.
create table if not exists replacement_events (
  id          bigint generated always as identity primary key,
  instance    text,
  domain      text,
  client_tag  text,
  event_type  text not null,   -- detected|proposed|tagged|redirect_set|attached|removed|cancel_queued|skipped|error
  detail      text,
  signals     jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists idx_replacement_events_created on replacement_events (created_at desc);
create index if not exists idx_replacement_events_domain on replacement_events (instance, domain);

-- Lock down: service-role bypasses RLS; anon/browser key gets nothing.
alter table replacement_settings       enable row level security;
alter table client_redirects           enable row level security;
alter table client_campaign_map        enable row level security;
alter table domain_replacement_state   enable row level security;
alter table replacement_events         enable row level security;
