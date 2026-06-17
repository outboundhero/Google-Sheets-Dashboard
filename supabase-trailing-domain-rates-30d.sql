-- trailing_domain_rates: add a 30-day window alongside the existing 10d/15d.
-- Same diff logic as before (latest snapshot on/before today-N as the baseline),
-- just an extra b30 CTE + reply_30/bounce_30/span_30 columns. Run in Supabase
-- SQL editor (replaces the deployed function). 30d values stay null until 30
-- days of deliverability_domain_snapshots history exist.
--
-- NOTE: this adds new output columns, so the function's return type changes —
-- Postgres rejects CREATE OR REPLACE in that case ("cannot change return type").
-- We DROP first, then recreate. Safe: the route recreates results on next call.
drop function if exists trailing_domain_rates(text[], date);

create or replace function trailing_domain_rates(p_instances text[], p_today date)
returns table (
  instance text,
  domain text,
  reply_10 numeric,
  reply_15 numeric,
  reply_30 numeric,
  bounce_10 numeric,
  bounce_15 numeric,
  bounce_30 numeric,
  span_10 int,
  span_15 int,
  span_30 int
)
language sql
stable
as $$
  with cur as (
    select distinct on (instance, domain)
      instance, domain, snapshot_date, total_sent, total_replied, total_bounced
    from deliverability_domain_snapshots
    where instance = any(p_instances) and snapshot_date <= p_today
    order by instance, domain, snapshot_date desc
  ),
  b10 as (
    select distinct on (instance, domain)
      instance, domain, snapshot_date, total_sent, total_replied, total_bounced
    from deliverability_domain_snapshots
    where instance = any(p_instances) and snapshot_date <= p_today - 10
    order by instance, domain, snapshot_date desc
  ),
  b15 as (
    select distinct on (instance, domain)
      instance, domain, snapshot_date, total_sent, total_replied, total_bounced
    from deliverability_domain_snapshots
    where instance = any(p_instances) and snapshot_date <= p_today - 15
    order by instance, domain, snapshot_date desc
  ),
  b30 as (
    select distinct on (instance, domain)
      instance, domain, snapshot_date, total_sent, total_replied, total_bounced
    from deliverability_domain_snapshots
    where instance = any(p_instances) and snapshot_date <= p_today - 30
    order by instance, domain, snapshot_date desc
  )
  select cur.instance, cur.domain,
    case when (cur.total_sent - b10.total_sent) > 0
      then round(100.0*(cur.total_replied - b10.total_replied)/(cur.total_sent - b10.total_sent), 2) end as reply_10,
    case when (cur.total_sent - b15.total_sent) > 0
      then round(100.0*(cur.total_replied - b15.total_replied)/(cur.total_sent - b15.total_sent), 2) end as reply_15,
    case when (cur.total_sent - b30.total_sent) > 0
      then round(100.0*(cur.total_replied - b30.total_replied)/(cur.total_sent - b30.total_sent), 2) end as reply_30,
    case when (cur.total_sent - b10.total_sent) > 0
      then round(100.0*(cur.total_bounced - b10.total_bounced)/(cur.total_sent - b10.total_sent), 2) end as bounce_10,
    case when (cur.total_sent - b15.total_sent) > 0
      then round(100.0*(cur.total_bounced - b15.total_bounced)/(cur.total_sent - b15.total_sent), 2) end as bounce_15,
    case when (cur.total_sent - b30.total_sent) > 0
      then round(100.0*(cur.total_bounced - b30.total_bounced)/(cur.total_sent - b30.total_sent), 2) end as bounce_30,
    (cur.snapshot_date - b10.snapshot_date) as span_10,
    (cur.snapshot_date - b15.snapshot_date) as span_15,
    (cur.snapshot_date - b30.snapshot_date) as span_30
  from cur
  left join b10 on b10.instance = cur.instance and b10.domain = cur.domain
  left join b15 on b15.instance = cur.instance and b15.domain = cur.domain
  left join b30 on b30.instance = cur.instance and b30.domain = cur.domain;
$$;
