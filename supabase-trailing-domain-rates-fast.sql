-- trailing_domain_rates_fast: the same rows as trailing_domain_rates_json, without
-- the four full-table sorts. Each domain's current / 10d / 15d / 30d baseline is a
-- single lookup on the (instance, domain, snapshot_date) primary key, so the cost
-- grows with the number of domains, not with days of snapshot history.
-- Measured 2026-10-15: trailing_domain_rates_json took 9.6s on 480k snapshot rows,
-- and the Replacement page runs it from four cards at once → statement timeout.
-- Run in the Supabase SQL editor. The app falls back to the JSON function until
-- this one exists.

create or replace function trailing_domain_rates_fast(p_instances text[], p_today date)
returns json
language sql
stable
as $$
  with doms as (
    select distinct instance, domain
    from deliverability_domain_snapshots
    where instance = any(p_instances) and snapshot_date <= p_today
  ),
  r as (
    select d.instance, d.domain,
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
    from doms d
    cross join lateral (
      select s.snapshot_date, s.total_sent, s.total_replied, s.total_bounced
      from deliverability_domain_snapshots s
      where s.instance = d.instance and s.domain = d.domain and s.snapshot_date <= p_today
      order by s.snapshot_date desc limit 1
    ) cur
    left join lateral (
      select s.snapshot_date, s.total_sent, s.total_replied, s.total_bounced
      from deliverability_domain_snapshots s
      where s.instance = d.instance and s.domain = d.domain and s.snapshot_date <= p_today - 10
      order by s.snapshot_date desc limit 1
    ) b10 on true
    left join lateral (
      select s.snapshot_date, s.total_sent, s.total_replied, s.total_bounced
      from deliverability_domain_snapshots s
      where s.instance = d.instance and s.domain = d.domain and s.snapshot_date <= p_today - 15
      order by s.snapshot_date desc limit 1
    ) b15 on true
    left join lateral (
      select s.snapshot_date, s.total_sent, s.total_replied, s.total_bounced
      from deliverability_domain_snapshots s
      where s.instance = d.instance and s.domain = d.domain and s.snapshot_date <= p_today - 30
      order by s.snapshot_date desc limit 1
    ) b30 on true
  )
  select coalesce(json_agg(r), '[]'::json) from r;
$$;

-- Check 1 — speed (old function: ~10s):
--   select json_array_length(trailing_domain_rates_fast(
--     array['outboundhero','cleaningoutbound','facilityreach','outboundclean'], current_date));
--
-- Check 2 — same output as the old function (expect 0 rows):
--   with a as (select * from json_to_recordset(trailing_domain_rates_json(
--           array['outboundhero','cleaningoutbound','facilityreach','outboundclean'], current_date)::json)
--         as x(instance text, domain text, reply_10 numeric, reply_15 numeric, reply_30 numeric,
--              bounce_10 numeric, bounce_15 numeric, bounce_30 numeric, span_10 int, span_15 int, span_30 int)),
--   b as (select * from json_to_recordset(trailing_domain_rates_fast(
--           array['outboundhero','cleaningoutbound','facilityreach','outboundclean'], current_date))
--         as x(instance text, domain text, reply_10 numeric, reply_15 numeric, reply_30 numeric,
--              bounce_10 numeric, bounce_15 numeric, bounce_30 numeric, span_10 int, span_15 int, span_30 int))
--   (select * from a except select * from b) union all (select * from b except select * from a);
