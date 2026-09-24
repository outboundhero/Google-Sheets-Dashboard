// Per-instance stock the buy list must credit before recommending purchases
// (Nick 2026-09-02: "make sure the system is pulling those domains first").
// Two counters, both instance-keyed:
//
//   usable reserve — untagged, warmed (≥21d), REAL inboxes behind it (the
//     empty-shell lesson), not Burnt/queued/skipped/Spamhaus. Same gates the
//     fill uses, so "the list credits it" and "the fill can actually pull it"
//     are the same statement.
//   in-flight — provider orders placed but not yet visible in the mirror
//     (Inboxing's upload window). Bought stock that must not be bought twice.
//
// Fail-open on the in-flight read only: an orders-table hiccup understates
// credit and over-buys, never under-buys. A reserve read failure throws — a
// silently-zero reserve would tell Spencer to buy hundreds he doesn't need.
import { getSupabaseAdmin } from "@/lib/supabase";
import { getHandledDomains } from "./store";
import { getSkipSet, skipKey } from "./skips";
import { hasBurntTag } from "./burnt-tag";
import { loadFirstCreated, effectiveAgeDays } from "./domain-age";
import { ALL_INSTANCE_SLUGS, type BisonInstanceSlug, PROTECTED_INSTANCE_DOMAINS } from "@/lib/bison-instances";

const WARMUP_DAYS = 21;

export interface StockCounts {
  usableReserve: Record<string, number>;
  inflight: Record<string, number>;
  /** In Bison with real inboxes, untagged, clean — just not 21 days old yet. Bought, don't re-buy. */
  warming: Record<string, number>;
  /** Of `warming`, how many cross the 21-day line within the next 7 days. */
  warmingReady7: Record<string, number>;
}

export async function getStockCounts(knownTagsUpper: Set<string>): Promise<StockCounts> {
  const supabase = getSupabaseAdmin();
  const [handled, skips, firstCreated] = await Promise.all([getHandledDomains(), getSkipSet(), loadFirstCreated()]);

  // inbox_count comes along for the ride: it is maintained by the
  // rebuild_domain_stats RPC and agrees exactly with the inboxes table
  // (129,995 on both sides, 2026-09-24). Counting the inboxes table by hand
  // meant ~130 paged reads of 130k rows on every run, which is what made this
  // route die with "canceling statement due to statement timeout".
  interface DomRow { instance: BisonInstanceSlug; domain: string; tags: string[] | null; domain_created_at: string | null; spamhaus_dbl: boolean | null; inbox_count: number | null }
  const doms: DomRow[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await supabase
      .from("deliverability_domains")
      .select("instance, domain, tags, domain_created_at, spamhaus_dbl, inbox_count")
      .order("domain", { ascending: true })
      .range(off, off + 999);
    if (error) throw new Error(`deliverability_domains: ${error.message}`);
    if (!data || data.length === 0) break;
    doms.push(...(data as DomRow[]));
    if (data.length < 1000) break;
  }
  const inboxCount = new Map<string, number>();
  for (const d of doms) inboxCount.set(`${d.instance}:${d.domain}`, d.inbox_count ?? 0);

  const now = Date.now();
  const usableReserve: Record<string, number> = {};
  const warming: Record<string, number> = {};
  const warmingReady7: Record<string, number> = {};
  for (const s of ALL_INSTANCE_SLUGS) { usableReserve[s] = 0; warming[s] = 0; warmingReady7[s] = 0; }
  const mirrorKeys = new Set<string>();
  for (const d of doms) {
    const key = `${d.instance}:${d.domain}`;
    mirrorKeys.add(`${d.instance}:${d.domain.toLowerCase()}`);
    if (PROTECTED_INSTANCE_DOMAINS.has(d.domain.toLowerCase())) continue; // instance roots are never stock
    if ((d.tags || []).some((t) => knownTagsUpper.has(String(t).trim().toUpperCase()))) continue;
    if (handled.has(key) || skips.has(skipKey(d.instance, d.domain)) || hasBurntTag(d.tags)) continue;
    if (d.spamhaus_dbl === true) continue;
    if (!((inboxCount.get(key) ?? 0) > 0)) continue; // shells don't count
    const age = effectiveAgeDays(d.domain, d.domain_created_at, firstCreated, now);
    if (age < WARMUP_DAYS) {
      warming[d.instance] = (warming[d.instance] || 0) + 1;
      if (age >= WARMUP_DAYS - 7) warmingReady7[d.instance] = (warmingReady7[d.instance] || 0) + 1;
      continue;
    }
    usableReserve[d.instance] = (usableReserve[d.instance] || 0) + 1;
  }

  const inflight: Record<string, number> = {};
  for (const s of ALL_INSTANCE_SLUGS) inflight[s] = 0;
  try {
    const orders: { instance: string | null; domain: string }[] = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase
        .from("inbox_orders")
        .select("instance, domain")
        // NB: inbox_order_status is a Postgres enum — an unknown value in the
        // filter errors the whole query (a phantom "processing" here zeroed
        // the in-flight credit on the first deploy). Only real values.
        .in("status", ["active", "pending"])
        .order("domain", { ascending: true })
        .range(off, off + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      orders.push(...(data as { instance: string | null; domain: string }[]));
      if (data.length < 1000) break;
    }
    const seen = new Set<string>();
    for (const o of orders) {
      if (!o.instance) continue;
      const k = `${o.instance}:${o.domain.toLowerCase()}`;
      if (seen.has(k) || mirrorKeys.has(k)) continue; // already visible → already counted
      seen.add(k);
      inflight[o.instance] = (inflight[o.instance] || 0) + 1;
    }
  } catch (e) {
    console.error("[stock-counts] in-flight read failed (credited as 0):", e);
  }

  return { usableReserve, inflight, warming, warmingReady7 };
}
