import { getSupabaseAdmin } from "@/lib/supabase";

// Maps a domain to the correct Inboxing REGISTRAR credential based on which
// Porkbun account the domain actually lives in (from the All Domains inventory,
// `domain_inventory.source`). Using the wrong registrar = Inboxing can't touch
// the domain's nameservers → "Nameserver update not detected" order failures.
//
// Credential IDs confirmed via GET /registrars + /cloudflare-credentials:
//   porkbun "Spencersellstech" → our spencersellstech account
//   porkbun "Spencer"          → our outboundhero account
//   cloudflare "OutboundHero"  → used for all orders
// IDs are references (not secrets); hardcoded with env overrides for flexibility.

export const INBOXING_CLOUDFLARE_CREDENTIAL_ID =
  process.env.INBOXING_CLOUDFLARE_CREDENTIAL_ID || "cmk5vg3ar03rxn001wt6fbm62";

const REGISTRAR_BY_SOURCE: Record<string, string> = {
  porkbun_outboundhero: process.env.INBOXING_REGISTRAR_OUTBOUNDHERO || "cmnga698v28nllo01fenxvzfw",
  porkbun_spencersellstech: process.env.INBOXING_REGISTRAR_SPENCERSELLSTECH || "cmpeijttad93eoe015paoqgkb",
};

export const PORKBUN_ACCOUNT_LABEL: Record<string, string> = {
  porkbun_outboundhero: "OutboundHero",
  porkbun_spencersellstech: "Spencersellstech",
  manual: "Manual",
};

export interface DomainRegistrar {
  domain: string;
  source: string | null;        // domain_inventory.source, or null if not in inventory
  accountLabel: string | null;  // human label for the Porkbun account
  registrarId: string | null;   // Inboxing registrar credential id (null = can't determine)
  cloudflareId: string;
  ok: boolean;                   // true when we have a registrar to order with
  reason: string | null;        // why not ok (for the UI)
}

/** Resolve the registrar credential for each domain from its Porkbun account. */
export async function resolveDomainRegistrars(domains: string[]): Promise<Map<string, DomainRegistrar>> {
  const supabase = getSupabaseAdmin();
  const norm = Array.from(new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean)));

  const sourceByDomain = new Map<string, string>();
  for (let i = 0; i < norm.length; i += 300) {
    const slice = norm.slice(i, i + 300);
    const { data } = await supabase.from("domain_inventory").select("domain, source").in("domain", slice);
    for (const r of data || []) sourceByDomain.set((r.domain as string).toLowerCase(), r.source as string);
  }

  const out = new Map<string, DomainRegistrar>();
  for (const d of norm) {
    const source = sourceByDomain.get(d) ?? null;
    const registrarId = source ? (REGISTRAR_BY_SOURCE[source] ?? null) : null;
    const accountLabel = source ? (PORKBUN_ACCOUNT_LABEL[source] ?? source) : null;
    let reason: string | null = null;
    if (!source) reason = "not in the All Domains inventory — run Refresh Porkbun";
    else if (!registrarId) reason = `no Inboxing registrar mapped for "${accountLabel}"`;
    out.set(d, {
      domain: d,
      source,
      accountLabel,
      registrarId,
      cloudflareId: INBOXING_CLOUDFLARE_CREDENTIAL_ID,
      ok: !!registrarId,
      reason,
    });
  }
  return out;
}
