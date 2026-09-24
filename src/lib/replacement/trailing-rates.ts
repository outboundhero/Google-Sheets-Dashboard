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

/** Every domain's trailing rates, keyed `instance:domain`. One RPC call. */
export async function loadTrailingRates(
  instances: readonly BisonInstanceSlug[],
  today: string,
): Promise<Map<string, RateRow>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("trailing_domain_rates_json", {
    p_instances: instances,
    p_today: today,
  });
  if (error) throw new Error(error.message);
  const rows = (Array.isArray(data) ? data : []) as RateRow[];
  const byKey = new Map<string, RateRow>();
  for (const r of rows) byKey.set(`${r.instance}:${r.domain}`, r);
  return byKey;
}
