// Metrics FREEZE for reserve domains (Spencer, 2026-08-26 alignment call): a
// domain that stops sending has trailing reply windows that decay toward
// null/zero, so a healthy domain parked in reserve for weeks starts to look
// burnt for doing nothing. The moment a domain is untagged into reserve its
// metrics are snapshotted here; health checks judge it by the snapshot; the
// row is removed when the domain is assigned to a client again.
//
// Populated and pruned by the hourly metric-freeze cron (sweep design: any
// untagged domain missing a row gets frozen within the hour — which also
// covers every untag path without touching them — and any row whose domain
// is client-tagged again is deleted). Readers: plan.ts and true-up.ts use
// the frozen metrics for untagged domains when deciding burnt.
import { getSupabaseAdmin } from "@/lib/supabase";
import type { DomainMetrics } from "./threshold-groups";

export interface FrozenRow {
  instance: string;
  domain: string;
  frozen_at: string;
  metrics: DomainMetrics;
}

/** `${instance}:${domain}` → frozen metrics. Fail-open: an error returns an
 *  empty map and callers fall back to live metrics. */
export async function getFrozenMetrics(): Promise<Map<string, DomainMetrics>> {
  const map = new Map<string, DomainMetrics>();
  try {
    const supabase = getSupabaseAdmin();
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase
        .from("reserve_metric_freeze")
        .select("instance, domain, metrics")
        .range(off, off + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      for (const r of data as FrozenRow[]) map.set(`${r.instance}:${r.domain}`, r.metrics);
      if (data.length < 1000) break;
    }
  } catch (e) {
    console.error("[metric-freeze] read failed (falling back to live metrics):", e);
  }
  return map;
}

export async function freezeMetrics(entries: { instance: string; domain: string; metrics: DomainMetrics }[]): Promise<void> {
  if (entries.length === 0) return;
  const supabase = getSupabaseAdmin();
  for (let i = 0; i < entries.length; i += 200) {
    const { error } = await supabase.from("reserve_metric_freeze").upsert(
      entries.slice(i, i + 200).map((e) => ({ instance: e.instance, domain: e.domain, metrics: e.metrics, frozen_at: new Date().toISOString() })),
      { onConflict: "instance,domain", ignoreDuplicates: true }, // first freeze wins — never overwrite an older snapshot with decayed numbers
    );
    if (error) throw new Error(error.message);
  }
}

export async function unfreeze(pairs: { instance: string; domain: string }[]): Promise<void> {
  const supabase = getSupabaseAdmin();
  for (const p of pairs) {
    await supabase.from("reserve_metric_freeze").delete().eq("instance", p.instance).eq("domain", p.domain);
  }
}
