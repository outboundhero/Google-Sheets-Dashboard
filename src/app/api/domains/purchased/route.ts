import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { SOURCE_LABEL, type InventoryProvider } from "@/lib/domain-inventory";

// GET /api/domains/purchased  (admin-only via middleware)
// Domains we registered THROUGH our system (porkbun_domains.registered = true),
// with price paid + purchase date, plus renewal date / in-use / provider pulled
// from the inventory + deliverability data.
export const maxDuration = 30;

export interface PurchasedRow {
  domain: string;
  pricePaid: number | null;
  purchasedAt: string | null;
  renewalDate: string | null;
  source: string;
  sourceLabel: string;
  inUse: boolean;
  provider: InventoryProvider;
  hidden: boolean;
  autoRenew: boolean | null;
  surblListed: boolean | null;
  surblCheckedAt: string | null;
  spamhausListed: boolean | null;
  spamhausCheckedAt: string | null;
}

// Prefer whichever blacklist result was checked most recently (inventory vs porkbun).
function pickRecent(
  a: { listed: boolean | null; at: string | null } | undefined,
  b: { listed: boolean | null; at: string | null } | undefined,
): { listed: boolean | null; at: string | null } {
  const av = a && a.at ? a : null;
  const bv = b && b.at ? b : null;
  if (av && bv) return (av.at! >= bv.at!) ? av : bv;
  return av || bv || { listed: a?.listed ?? b?.listed ?? null, at: null };
}

function providerFromCounts(outlook: number, google: number): InventoryProvider {
  if (outlook > 0 && google > 0) return "mixed";
  if (outlook > 0) return "outlook";
  if (google > 0) return "google";
  return "unknown";
}

export async function GET() {
  try {
    const supabase = getSupabaseAdmin();

    // 1. Everything we registered (+ its SURBL/Spamhaus results if checked here).
    const purchased: {
      domain: string; price: number | null; purchasedAt: string | null;
      surbl: { listed: boolean | null; at: string | null }; spamhaus: { listed: boolean | null; at: string | null };
    }[] = [];
    let from = 0;
    for (let guard = 0; guard < 100; guard++) {
      const { data, error } = await supabase
        .from("porkbun_domains")
        .select("domain, price_usd, registered_at, surbl_listed, surbl_checked_at, spamhaus_listed, spamhaus_checked_at")
        .eq("registered", true)
        .order("registered_at", { ascending: false })
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      const rows = data || [];
      for (const r of rows) {
        const p = typeof r.price_usd === "number" ? r.price_usd : parseFloat(String(r.price_usd ?? ""));
        purchased.push({
          domain: r.domain as string,
          price: Number.isFinite(p) ? p : null,
          purchasedAt: (r.registered_at as string) || null,
          surbl: { listed: (r.surbl_listed as boolean | null) ?? null, at: (r.surbl_checked_at as string | null) ?? null },
          spamhaus: { listed: (r.spamhaus_listed as boolean | null) ?? null, at: (r.spamhaus_checked_at as string | null) ?? null },
        });
      }
      if (rows.length < 1000) break;
      from += 1000;
    }

    const domains = purchased.map((p) => p.domain);
    if (domains.length === 0) {
      return NextResponse.json({ rows: [], counts: { total: 0, totalSpent: 0 } });
    }

    // 2. Inventory (renewal date / source / mx provider / hidden / auto-renew /
    //    blacklist results) for those domains.
    const inv = new Map<string, {
      source: string; expire: string | null; mx: string | null; hidden: boolean; autoRenew: boolean | null;
      surbl: { listed: boolean | null; at: string | null }; spamhaus: { listed: boolean | null; at: string | null };
    }>();
    for (let i = 0; i < domains.length; i += 300) {
      const slice = domains.slice(i, i + 300);
      const { data } = await supabase
        .from("domain_inventory")
        .select("domain, source, expire_date, mx_provider, hidden, auto_renew, surbl_listed, surbl_checked_at, spamhaus_listed, spamhaus_checked_at")
        .in("domain", slice);
      for (const r of data || []) {
        inv.set(r.domain as string, {
          source: (r.source as string) || "porkbun_outboundhero",
          expire: (r.expire_date as string) || null,
          mx: (r.mx_provider as string) || null,
          hidden: !!r.hidden,
          autoRenew: (r.auto_renew as boolean | null) ?? null,
          surbl: { listed: (r.surbl_listed as boolean | null) ?? null, at: (r.surbl_checked_at as string | null) ?? null },
          spamhaus: { listed: (r.spamhaus_listed as boolean | null) ?? null, at: (r.spamhaus_checked_at as string | null) ?? null },
        });
      }
    }

    // 3. Deliverability (in-use + provider) for those domains, unioned across instances.
    const deliv = new Map<string, { inbox: number; outlook: number; google: number }>();
    for (let i = 0; i < domains.length; i += 300) {
      const slice = domains.slice(i, i + 300);
      const { data } = await supabase
        .from("deliverability_domains")
        .select("domain, inbox_count, outlook_count, google_count")
        .in("domain", slice);
      for (const r of data || []) {
        const prev = deliv.get(r.domain as string) || { inbox: 0, outlook: 0, google: 0 };
        prev.inbox += (r.inbox_count as number) ?? 0;
        prev.outlook += (r.outlook_count as number) ?? 0;
        prev.google += (r.google_count as number) ?? 0;
        deliv.set(r.domain as string, prev);
      }
    }

    const rows: PurchasedRow[] = purchased.map((p) => {
      const i = inv.get(p.domain);
      const d = deliv.get(p.domain);
      const inUse = (d?.inbox ?? 0) > 0;
      const provider: InventoryProvider = inUse && d
        ? providerFromCounts(d.outlook, d.google)
        : ((i?.mx as InventoryProvider) ?? "unknown");
      const source = i?.source || "porkbun_outboundhero";
      const surbl = pickRecent(i?.surbl, p.surbl);
      const spamhaus = pickRecent(i?.spamhaus, p.spamhaus);
      return {
        domain: p.domain,
        pricePaid: p.price,
        purchasedAt: p.purchasedAt,
        renewalDate: i?.expire ?? null,
        source,
        sourceLabel: SOURCE_LABEL[source] || source,
        inUse,
        provider,
        hidden: i?.hidden ?? false,
        autoRenew: i?.autoRenew ?? null,
        surblListed: surbl.listed,
        surblCheckedAt: surbl.at,
        spamhausListed: spamhaus.listed,
        spamhausCheckedAt: spamhaus.at,
      };
    });

    const totalSpent = rows.reduce((s, r) => s + (r.pricePaid || 0), 0);
    return NextResponse.json({ rows, counts: { total: rows.length, totalSpent } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
