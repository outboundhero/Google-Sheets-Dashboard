import { getSupabaseAdmin } from "@/lib/supabase";

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
  provider: InventoryProvider;
  providerSource: "deliverability" | "mx" | "none";
  expireDate: string | null;
  autoRenew: boolean | null;
  porkbunStatus: string | null;
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
      .select("domain, source, manual, tld, porkbun_status, expire_date, auto_renew, mx_provider")
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

export async function assembleInventory(): Promise<{ rows: InventoryRow[]; counts: InventoryCounts }> {
  const [inv, deliv] = await Promise.all([readInventory(), readDeliverability()]);

  const rows: InventoryRow[] = inv.map((r) => {
    const d = deliv.get(r.domain);
    const inUse = (d?.inbox ?? 0) > 0;
    let provider: InventoryProvider;
    let providerSource: InventoryRow["providerSource"];
    if (inUse && d) {
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
      provider,
      providerSource,
      expireDate: r.expire_date,
      autoRenew: r.auto_renew,
      porkbunStatus: r.porkbun_status,
    };
  });

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
