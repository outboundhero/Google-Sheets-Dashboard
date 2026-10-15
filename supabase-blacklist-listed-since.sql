-- When each domain's current SURBL / Spamhaus listing started, for the domain
-- stats export (Nick 2026-10-15: "date it was first listed").
--
-- A trigger, so all three writers — the Check SURBL / Check Spamhaus buttons
-- and the hourly blacklist-recheck cron — stamp it without code changes:
--   clean -> listed      : listed_since = now() (the check that first saw it)
--   listed -> clean      : listed_since cleared
--   never checked -> listed, or listed before this ran: stays null — we don't
--                          know when that listing started.
-- `update of blacklisted, spamhaus_dbl` keeps it off the stats rebuild, which
-- never sets those columns.
-- Run in the Supabase SQL editor BEFORE deploying the code that reads these
-- columns (the domains route selects them).

alter table deliverability_domains
  add column if not exists blacklist_listed_since timestamptz,
  add column if not exists spamhaus_listed_since timestamptz;

create or replace function stamp_blacklist_listed_since()
returns trigger
language plpgsql
as $$
begin
  if new.blacklisted is distinct from old.blacklisted then
    if new.blacklisted is true and old.blacklisted is false then
      new.blacklist_listed_since := now();
    elsif new.blacklisted is not true then
      new.blacklist_listed_since := null;
    end if;
  end if;
  if new.spamhaus_dbl is distinct from old.spamhaus_dbl then
    if new.spamhaus_dbl is true and old.spamhaus_dbl is false then
      new.spamhaus_listed_since := now();
    elsif new.spamhaus_dbl is not true then
      new.spamhaus_listed_since := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists deliverability_domains_listed_since on deliverability_domains;
create trigger deliverability_domains_listed_since
  before update of blacklisted, spamhaus_dbl on deliverability_domains
  for each row execute function stamp_blacklist_listed_since();
