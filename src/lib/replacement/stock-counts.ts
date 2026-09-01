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
import { ALL_INSTANCE_SLUGS, type BisonInstanceSlug } from "@/lib/bison-instances";

const WARMUP_DAYS = 21;

export interface StockCounts {
  usableReserve: Record<string, number>;
  inflight: Record<string, number>;
}

export async function getStockCounts(knownTagsUpper: Set<string>): Promise<StockCounts> {
  const supabase = getSupabaseAdmin();
  const [handled, skips] = await Promise.all([getHandledDomains(), getSkipSet()]);

  interface DomRow { instance: BisonInstanceSlug; domain: string; tags: string[] | null; domain_created_at: string | null; spamhaus_dbl: boolean | null }
  const doms: DomRow[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await supabase
      .from("deliverability_domains")
      .select("instance, domain, tags, domain_created_at, spamhaus_dbl")
      .order("domain", { ascending: true })
      .range(off, off + 999);
    if (error) throw new Error(`deliverability_domains: ${error.message}`);
    if (!data || data.length === 0) break;
    doms.push(...(data as DomRow[]));
    if (data.length < 1000) break;
  }
  const inboxCount = new Map<string, number>();
  for (let off = 0; ; off += 1000) {
    const { data, error } = await supabase
      .from("deliverability_inboxes")
      .select("instance, domain")
      .order("id", { ascending: true })
      .range(off, off + 999);
    if (error) throw new Error(`deliverability_inboxes: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const i of data as { instance: string; domain: string }[]) {
      const k = `${i.instance}:${i.domain}`;
      inboxCount.set(k, (inboxCount.get(k) || 0) + 1);
    }
    if (data.length < 1000) break;
  }

  const now = Date.now();
  const usableReserve: Record<string, number> = {};
  for (const s of ALL_INSTANCE_SLUGS) usableReserve[s] = 0;
  const mirrorKeys = new Set<string>();
  for (const d of doms) {
    const key = `${d.instance}:${d.domain}`;
    mirrorKeys.add(`${d.instance}:${d.domain.toLowerCase()}`);
    if ((d.tags || []).some((t) => knownTagsUpper.has(String(t).trim().toUpperCase()))) continue;
    if (handled.has(key) || skips.has(skipKey(d.instance, d.domain)) || hasBurntTag(d.tags)) continue;
    if (!d.domain_created_at || now - new Date(d.domain_created_at).getTime() < WARMUP_DAYS * 86_400_000) continue;
    if (d.spamhaus_dbl === true) continue;
    if (!(inboxCount.get(key)! > 0)) continue; // shells don't count
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
        .in("status", ["active", "pending", "processing"])
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

  return { usableReserve, inflight };
}
