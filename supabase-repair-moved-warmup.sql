-- One-time repair (2026-10-17, Nick): moved domains whose warmup clock
-- restarted give back the start date they had on the instance they came from.
-- Source of truth = the earliest daily snapshot of the domain on its source
-- instance. Only touches domains with a recorded move, and only ever moves a
-- date EARLIER. Dry run on 2026-10-17: 34 records added, 39 moved earlier;
-- 25 domains go from "11d left" back to "Complete" (the CRJS/BWCS domains
-- moved B2B #1 → B2B #2 on Oct 6). New moves record this themselves
-- (src/lib/deliverability/first-seen.ts).

with moves as (
  select distinct domain, signals->>'from' as src
  from replacement_events
  where event_type = 'move_submitted' and signals->>'from' is not null
),
src_start as (
  select m.domain, m.src, min(s.snapshot_date) as first_day
  from moves m
  join deliverability_domain_snapshots s on s.domain = m.domain and s.instance = m.src
  group by m.domain, m.src
),
best as (
  select distinct on (domain) domain, src, first_day
  from src_start
  order by domain, first_day
)
insert into domain_first_created (domain, first_created_at, first_instance)
select domain, first_day::timestamptz, src from best
on conflict (domain) do update
  set first_created_at = excluded.first_created_at,
      first_instance = excluded.first_instance
  where excluded.first_created_at < domain_first_created.first_created_at;
