-- =============================================================================
-- Turbo Mode + auto-throttle (Nick's "Performance & Turbo Mode" spec, Sep 23 2026)
-- =============================================================================
-- All NEW tables — nothing existing is altered. Run in the Supabase SQL editor.
-- Read/written only through the service-role admin client; RLS on, no policies.
--
--   sending_mode_settings   single row of tunables (limits, 15 days, 125/110 %)
--   sending_windows         one row per Turbo or throttle window (the log)
--   sending_window_accounts the per-account snapshot a window restores from
--   client_sending_prefs    per-client "auto-throttle paused" switch
--   client_sending_status   QL pace per client, refreshed by the cron (feeds the tab)
-- =============================================================================

create table if not exists sending_mode_settings (
  id                    int primary key default 1,
  turbo_days            int     not null default 15,
  turbo_warmup_limit    int     not null default 5,    -- warm-up/day while in Turbo (normal 8)
  turbo_daily_limit     int     not null default 8,    -- campaign sends/day while in Turbo (normal 5)
  throttle_daily_limit  int     not null default 3,    -- campaign sends/day while throttled
  throttle_on_pace      numeric not null default 1.25, -- throttle when pace ≥ this
  throttle_off_pace     numeric not null default 1.10, -- release when pace < this
  grace_days            int     not null default 5,    -- no status / no throttle in the first N days
  turbo_window_days     int     not null default 15,   -- "≤ N days left" line for Critical
  full_credit_fraction  numeric not null default 0.5,  -- projected ≤ guarantee × this → 100% credit band
  updated_at            timestamptz not null default now(),
  constraint sending_mode_settings_singleton check (id = 1)
);
insert into sending_mode_settings (id) values (1) on conflict (id) do nothing;

create table if not exists sending_windows (
  id               uuid primary key default gen_random_uuid(),
  client_tag       text not null,
  kind             text not null,                         -- 'turbo' | 'throttle'
  status           text not null default 'applying',      -- applying | active | reverting | ended | revert_failed
  started_at       timestamptz not null default now(),
  ends_at          timestamptz,                           -- turbo: started_at + turbo_days; throttle: null
  ended_at         timestamptz,
  end_reason       text,                                  -- expired | cancelled | churned | paused | inactive | released | pace_below_off | new_period | guarantee_at_risk | turbo_started
  activated_by     text,                                  -- email, or 'auto-throttle' / 'cron'
  trigger_detail   text,
  status_at_start  text,
  pace_at_start    numeric,
  qls_at_start     int,
  sent_at_start    bigint,                                -- sum of emails_sent_count on the accounts
  pace_at_end      numeric,
  qls_at_end       int,
  sent_at_end      bigint,
  account_count    int not null default 0,
  applied_limits   jsonb,                                 -- {daily, warmup} that was applied
  revert_attempts  int not null default 0,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists sending_windows_client_idx on sending_windows (client_tag, status);
create index if not exists sending_windows_status_idx on sending_windows (status);

create table if not exists sending_window_accounts (
  window_id          uuid not null references sending_windows(id) on delete cascade,
  instance           text not null,
  inbox_id           bigint not null,
  email              text,
  domain             text,
  prev_daily_limit   int,
  prev_warmup_limit  int,                                 -- null = not read, warm-up left alone
  applied            boolean not null default false,
  reverted           boolean not null default false,
  verified           boolean not null default false,
  last_error         text,
  primary key (window_id, instance, inbox_id)
);

create table if not exists client_sending_prefs (
  client_tag            text primary key,
  auto_throttle_paused  boolean not null default false,
  updated_by            text,
  updated_at            timestamptz not null default now()
);

create table if not exists client_sending_status (
  client_tag        text primary key,
  company_name      text,
  plan              text,
  guarantee         int not null,
  cycle_start       date not null,
  cycle_end         date not null,
  cycle_length      int not null,
  days_elapsed      int not null,
  days_remaining    int not null,
  qls_delivered     int not null,
  expected_to_date  numeric not null,
  pace              numeric,                              -- delivered / expected (null in grace)
  projected         int,
  status            text not null,                        -- grace | on_track | at_risk | critical | overperforming
  leaving_on        date,                                 -- churn/pause date when scheduled
  leaving_kind      text,                                 -- churn | pause
  tracker_status    text,
  evaluated_at      timestamptz not null default now()
);

alter table sending_mode_settings     enable row level security;
alter table sending_windows           enable row level security;
alter table sending_window_accounts   enable row level security;
alter table client_sending_prefs      enable row level security;
alter table client_sending_status     enable row level security;

-- Auto-throttle on/off switch (Performance tab, 2026-10-09). Ships OFF.
alter table sending_mode_settings
  add column if not exists auto_throttle_enabled    boolean not null default false,
  add column if not exists auto_throttle_updated_by text,
  add column if not exists auto_throttle_updated_at timestamptz;
