import { getSupabaseAdmin } from "@/lib/supabase";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

// One way to read trailing domain rates, because there is one expensive scan
// behind them.
//
// PostgREST re-executes a set-returning function for EVERY `.range()` request,
// so the old `.rpc("trailing_domain_rates").range(off, off+999)` loop ran the
// whole snapshot scan once per page — 8 pages for 7,959 domains. Measured
// 2026-09-25: the paginated loop took 46s and its first page alone exceeded
// Postgres's statement timeout, which is what put "canceling statement due to
// statement timeout" on the Replacement page's plan, flagged-domains and
// true-up cards (Spencer, 08:08).
//
// `trailing_domain_rates_json` runs the scan ONCE and returns every row in a
// single JSON array, with no 1000-row cap. Same 7,959 rows in 8.9s.
//
// That was still too slow once the snapshot table grew: 9.6s on 480k rows
// (2026-10-15), and the plan-groups, detect-groups, shortfall and true-up cards
// all run it together on page load, so they timed out again.
// `trailing_domain_rates_fast` (supabase-trailing-domain-rates-fast.sql) looks
// each domain up on the primary key instead of sorting the table four times; the
// JSON function stays as the fallback until it is created. Callers that arrive
// within a minute of each other share one query — snapshots land once a day.

export interface RateRow {
  instance: string;
  domain: string;
  reply_10: number | null;
  reply_15: number | null;
  reply_30: number | null;
  bounce_10: number | null;
  bounce_15: number | null;
  bounce_30: number | null;
  span_10: number | null;
  span_15: number | null;
  span_30: number | null;
}

const SHARE_MS = 60_000;
const recent = new Map<string, { at: number; rows: Promise<RateRow[]> }>();

async function queryRates(instances: readonly BisonInstanceSlug[], today: string): Promise<RateRow[]> {
  const supabase = getSupabaseAdmin();
  const args = { p_instances: instances, p_today: today };
  let { data, error } = await supabase.rpc("trailing_domain_rates_fast", args);
  // PGRST202 = the fast function hasn't been created in Supabase yet.
  if (error?.code === "PGRST202") ({ data, error } = await supabase.rpc("trailing_domain_rates_json", args));
  if (error) throw new Error(error.message);
  return (Array.isArray(data) ? data : []) as RateRow[];
}

/** Every domain's trailing rates as rows. One RPC call, shared for a minute. */
export function loadTrailingRateRows(
  instances: readonly BisonInstanceSlug[],
  today: string,
): Promise<RateRow[]> {
  const key = `${[...instances].sort().join(",")}|${today}`;
  const hit = recent.get(key);
  if (hit && Date.now() - hit.at < SHARE_MS) return hit.rows;
  const rows = queryRates(instances, today);
  recent.set(key, { at: Date.now(), rows });
  rows.catch(() => { if (recent.get(key)?.rows === rows) recent.delete(key); });
  return rows;
}

/** Every domain's trailing rates, keyed `instance:domain`. */
export async function loadTrailingRates(
  instances: readonly BisonInstanceSlug[],
  today: string,
): Promise<Map<string, RateRow>> {
  const byKey = new Map<string, RateRow>();
  for (const r of await loadTrailingRateRows(instances, today)) byKey.set(`${r.instance}:${r.domain}`, r);
  return byKey;
}
