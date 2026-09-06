import { getSupabaseAdmin } from "@/lib/supabase";
import { PROTECTED_INSTANCE_DOMAINS } from "@/lib/bison-instances";
import { getThresholdConfig } from "@/lib/replacement/threshold-groups-store";
import { defaultThresholdConfig } from "@/lib/replacement/threshold-groups";

// Shared helpers + the merged-inventory assembler for the "All Domains" tab.
// In-use and deliverability-derived provider are computed LIVE from
// deliverability_domains (inbox counts change on every rebuild). MX-derived
// provider is read from the cached domain_inventory.mx_provider column.

export const SOURCE_LABEL: Record<string, string> = {
  porkbun_outboundhero: "Porkbun · outboundhero",
  porkbun_spencersellstech: "Porkbun · spencersellstech",
  manual: "Manual",
};

export type InventoryProvider = "google" | "outlook" | "mixed" | "zoho" | "porkbun" | "other" | "parked" | "no-dns" | "unknown";

export interface InventoryRow {
  domain: string;
  source: string;
  sourceLabel: string;
  manual: boolean;
  tld: string | null;
  inUse: boolean;
  /** In use only because an order exists — mailboxes haven't reached Bison yet. */
  inUsePending: boolean;
  provider: InventoryProvider;
  providerSource: "deliverability" | "mx" | "none";
  expireDate: string | null;
  autoRenew: boolean | null;
  porkbunStatus: string | null;
  hidden: boolean;
  surblListed: boolean | null;
  surblCheckedAt: string | null;
  spamhausListed: boolean | null;
  spamhausCheckedAt: string | null;
  /** §13/§15 of Spencer's Jul-29 requirements: owned domain safe to hand out
   *  as reserve/reuse. Empty blockers = eligible. */
  reuseEligible: boolean;
  reuseBlockers: string[];
}

export interface InventoryCounts {
  total: number;
  bySource: Record<string, number>;
  inUse: number;
  notInUse: number;
  byProvider: Record<string, number>;
}

/** Normalize a raw domain string: lowercase, strip scheme/www/path/query. */
export function normalizeDomain(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let d = raw.trim().toLowerCase();
  if (!d) return null;
  d = d.replace(/^https?:\/\//, "").replace(/^www\./, "");
  d = d.split(/[/?#]/)[0].trim();
  d = d.replace(/\.+$/, "");
  if (!d.includes(".") || /\s/.test(d)) return null;
  if (!/^[a-z0-9.-]+$/.test(d)) return null;
  return d;
}

function providerFromCounts(outlook: number, google: number): InventoryProvider {
  if (outlook > 0 && google > 0) return "mixed";
  if (outlook > 0) return "outlook";
  if (google > 0) return "google";
  return "unknown";
}

interface RawInventoryRow {
  domain: string;
  source: string;
  manual: boolean | null;
  tld: string | null;
  porkbun_status: string | null;
  expire_date: string | null;
  auto_renew: boolean | null;
  mx_provider: string | null;
  hidden: boolean | null;
  surbl_listed: boolean | null;
  surbl_checked_at: string | null;
  spamhaus_listed: boolean | null;
  spamhaus_checked_at: string | null;
}

/** Read every domain_inventory row (paged). */
async function readInventory(): Promise<RawInventoryRow[]> {
  const supabase = getSupabaseAdmin();
  const out: RawInventoryRow[] = [];
  let from = 0;
  const PAGE = 1000;
  for (let guard = 0; guard < 100; guard++) {
    const { data, error } = await supabase
      .from("domain_inventory")
      .select("domain, source, manual, tld, porkbun_status, expire_date, auto_renew, mx_provider, hidden, surbl_listed, surbl_checked_at, spamhaus_listed, spamhaus_checked_at")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data || []) as RawInventoryRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

/** Read deliverability_domains inbox/provider counts, unioned across instances. */
async function readDeliverability(): Promise<Map<string, { inbox: number; outlook: number; google: number }>> {
  const supabase = getSupabaseAdmin();
  const map = new Map<string, { inbox: number; outlook: number; google: number }>();
  let from = 0;
  const PAGE = 1000;
  for (let guard = 0; guard < 200; guard++) {
    const { data, error } = await supabase
      .from("deliverability_domains")
      .select("domain, inbox_count, outlook_count, google_count")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data || []) as { domain: string; inbox_count: number | null; outlook_count: number | null; google_count: number | null }[];
    for (const r of rows) {
      const prev = map.get(r.domain) || { inbox: 0, outlook: 0, google: 0 };
      prev.inbox += r.inbox_count ?? 0;
      prev.outlook += r.outlook_count ?? 0;
      prev.google += r.google_count ?? 0;
      map.set(r.domain, prev);
    }
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return map;
}

// Domains claimed by a live inbox order. Inbox counts only appear once the
// mailboxes reach Bison AND the per-instance deliverability cron next runs
// (every 2 days), so between ordering and that crawl a domain looked free —
// and could be handed out again as a reserve. An order claims it immediately.
// Failed/deleted orders release it again.
const ORDER_CLAIMS_DOMAIN = ["pending", "active", "swapping", "swapped"];

async function readOrderedDomains(): Promise<Set<string>> {
  const supabase = getSupabaseAdmin();
  const claimed = new Set<string>();
  let from = 0;
  const PAGE = 1000;
  for (let guard = 0; guard < 200; guard++) {
    const { data, error } = await supabase
      .from("inbox_orders")
      .select("domain")
      .in("status", ORDER_CLAIMS_DOMAIN)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data || []) as { domain: string | null }[];
    for (const r of rows) if (r.domain) claimed.add(r.domain.toLowerCase());
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return claimed;
}


/** Spencer's Jul-29 §13/§15 owned-domain reuse rules, one place. Empty result
 *  = eligible. Naming/keyword rules (§14) layer on top per client category. */
export const REUSE_MIN_EXPIRY_DAYS = 100;
export const BLACKLIST_FRESH_DAYS = 30;
function computeReuseBlockers(r: {
  domain: string; inUse: boolean; inUsePending: boolean; hidden: boolean;
  expireDate: string | null; autoRenew: boolean | null;
  surblListed: boolean | null; surblCheckedAt: string | null;
  spamhausListed: boolean | null; spamhausCheckedAt: string | null;
}): string[] {
  const out: string[] = [];
  if (PROTECTED_INSTANCE_DOMAINS.has(r.domain.toLowerCase())) out.push("protected instance domain — never reusable");
  if (r.inUse) out.push(r.inUsePending ? "claimed by a live inbox order" : "in use (has inboxes)");
  if (r.hidden) out.push("hidden from inventory");
  // Expiry: auto-renew ON always passes; OFF needs >100 days of runway.
  if (r.autoRenew !== true) {
    if (!r.expireDate) out.push("no expiry date on record (auto-renew off)");
    else {
      const days = Math.floor((new Date(r.expireDate).getTime() - Date.now()) / 86_400_000);
      if (days <= REUSE_MIN_EXPIRY_DAYS) out.push(`expires in ${days}d with auto-renew off (needs > ${REUSE_MIN_EXPIRY_DAYS}d)`);
    }
  }
  if (r.surblListed === true) out.push("SURBL listed");
  if (r.spamhausListed === true) out.push("Spamhaus listed");
  const fresh = (iso: string | null) => iso != null && Date.now() - new Date(iso).getTime() <= BLACKLIST_FRESH_DAYS * 86_400_000;
  if (r.surblListed !== true && !fresh(r.surblCheckedAt)) out.push("SURBL check missing/older than 30d — re-check first");
  if (r.spamhausListed !== true && !fresh(r.spamhausCheckedAt)) out.push("Spamhaus check missing/older than 30d — re-check first");
  return out;
}

export async function assembleInventory(): Promise<{ rows: InventoryRow[]; counts: InventoryCounts }> {
  const [inv, deliv, ordered] = await Promise.all([readInventory(), readDeliverability(), readOrderedDomains()]);

  // §14 naming rules from the DEFAULT (cleaning) segment — reserves are for
  // cleaning clients, so a reusable domain must read like one. Fail-open: a
  // config read error must never blank the inventory.
  let kwInclude: string[] = [];
  let kwExclude: string[] = [];
  try {
    const cfg = await getThresholdConfig();
    const def = cfg.segments.find((sg) => sg.isDefault);
    // Configs saved before the keyword fields existed have neither key —
    // fall back to the seeded cleaning defaults so the rule isn't inert.
    const seeded = def && def.keywordsInclude === undefined && def.keywordsExclude === undefined
      ? defaultThresholdConfig().segments.find((sg) => sg.isDefault)
      : def;
    kwInclude = (seeded?.keywordsInclude ?? []).map((k) => k.toLowerCase());
    kwExclude = (seeded?.keywordsExclude ?? []).map((k) => k.toLowerCase());
  } catch { /* keyword rule skipped this load */ }

  const rows: InventoryRow[] = inv.map((r) => {
    const d = deliv.get(r.domain);
    const hasInboxes = (d?.inbox ?? 0) > 0;
    const inUsePending = !hasInboxes && ordered.has(r.domain);
    const inUse = hasInboxes || inUsePending;
    let provider: InventoryProvider;
    let providerSource: InventoryRow["providerSource"];
    // Only real inbox counts describe a provider — an order that hasn't
    // landed yet tells us nothing, so those fall through to MX.
    if (hasInboxes && d) {
      provider = providerFromCounts(d.outlook, d.google);
      providerSource = "deliverability";
    } else if (r.mx_provider) {
      provider = r.mx_provider as InventoryProvider;
      providerSource = "mx";
    } else {
      provider = "unknown";
      providerSource = "none";
    }
    return {
      domain: r.domain,
      source: r.source,
      sourceLabel: SOURCE_LABEL[r.source] || r.source,
      manual: !!r.manual,
      tld: r.tld,
      inUse,
      inUsePending,
      provider,
      providerSource,
      expireDate: r.expire_date,
      autoRenew: r.auto_renew,
      porkbunStatus: r.porkbun_status,
      hidden: !!r.hidden,
      surblListed: r.surbl_listed,
      surblCheckedAt: r.surbl_checked_at,
      spamhausListed: r.spamhaus_listed,
      spamhausCheckedAt: r.spamhaus_checked_at,
      reuseEligible: false,
      reuseBlockers: [],
    };
  });
  for (const row of rows) {
    row.reuseBlockers = computeReuseBlockers(row);
    const name = row.domain.toLowerCase();
    const hitExclude = kwExclude.find((k) => name.includes(k));
    if (hitExclude) row.reuseBlockers.push(`name contains excluded keyword "${hitExclude}"`);
    else if (kwInclude.length > 0 && !kwInclude.some((k) => name.includes(k)))
      row.reuseBlockers.push("name doesn't match the cleaning naming keywords");
    row.reuseEligible = row.reuseBlockers.length === 0;
  }

  rows.sort((a, b) => a.domain.localeCompare(b.domain));

  const counts: InventoryCounts = {
    total: rows.length,
    bySource: {},
    inUse: 0,
    notInUse: 0,
    byProvider: {},
  };
  for (const r of rows) {
    counts.bySource[r.source] = (counts.bySource[r.source] || 0) + 1;
    if (r.inUse) counts.inUse++; else counts.notInUse++;
    counts.byProvider[r.provider] = (counts.byProvider[r.provider] || 0) + 1;
  }

  return { rows, counts };
}
