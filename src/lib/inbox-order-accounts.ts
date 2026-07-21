import { getSupabaseAdmin } from "@/lib/supabase";
import type { InboxOrderProvider } from "@/types/inbox-order";

// Resolves a domain to the correct provider credential based on which Porkbun
// account the domain lives in (from the All Domains inventory,
// `domain_inventory.source`). Using the wrong account = the provider can't
// manage the domain's DNS → order failures ("Nameserver update not detected").
//
// Each provider selects its account differently:
//   Inboxing  → registrar_credential_id (+ shared cloudflare_credential_id)
//   MilkBox   → domain_provider_id (UUID from GET /api/v1/domain-providers)
//   ScaledMail→ Porkbun hosting login (username/password)
// Per-account env vars are preferred; a legacy single-account env var is the
// fallback so existing setups keep working until the per-account vars are set.

export const PORKBUN_ACCOUNT_LABEL: Record<string, string> = {
  porkbun_outboundhero: "OutboundHero",
  porkbun_spencersellstech: "Spencersellstech",
  manual: "Manual",
};

// ── Inboxing ────────────────────────────────────────────────────────────────
export const INBOXING_CLOUDFLARE_CREDENTIAL_ID =
  process.env.INBOXING_CLOUDFLARE_CREDENTIAL_ID || "cmk5vg3ar03rxn001wt6fbm62";

function inboxingRegistrarFor(source: string | null): string | null {
  if (!source) return null;
  const map: Record<string, string | undefined> = {
    porkbun_outboundhero: process.env.INBOXING_REGISTRAR_OUTBOUNDHERO || "cmnga698v28nllo01fenxvzfw",
    porkbun_spencersellstech: process.env.INBOXING_REGISTRAR_SPENCERSELLSTECH || "cmpeijttad93eoe015paoqgkb",
  };
  return map[source] ?? null;
}

// ── MilkBox (domain-provider UUIDs from GET /api/v1/domain-providers) ─────────
function milkboxProviderFor(source: string | null): string | null {
  if (!source) return null;
  const map: Record<string, string | undefined> = {
    porkbun_outboundhero: process.env.MILKBOX_DOMAIN_PROVIDER_OUTBOUNDHERO,
    porkbun_spencersellstech: process.env.MILKBOX_DOMAIN_PROVIDER_SPENCERSELLSTECH,
  };
  return map[source] ?? process.env.MILKBOX_DOMAIN_PROVIDER_ID ?? null; // legacy fallback
}

// ── ScaledMail (Porkbun hosting login per account) ────────────────────────────
function scaledmailHostingFor(source: string | null): { username: string; password: string } | null {
  const per: Record<string, { u?: string; p?: string }> = {
    porkbun_outboundhero: { u: process.env.SCALEDMAIL_PORKBUN_USERNAME_OUTBOUNDHERO, p: process.env.SCALEDMAIL_PORKBUN_PASSWORD_OUTBOUNDHERO },
    porkbun_spencersellstech: { u: process.env.SCALEDMAIL_PORKBUN_USERNAME_SPENCERSELLSTECH, p: process.env.SCALEDMAIL_PORKBUN_PASSWORD_SPENCERSELLSTECH },
  };
  const c = source ? per[source] : undefined;
  if (c?.u && c?.p) return { username: c.u, password: c.p };
  const u = process.env.SCALEDMAIL_PORKBUN_USERNAME, p = process.env.SCALEDMAIL_PORKBUN_PASSWORD; // legacy
  return u && p ? { username: u, password: p } : null;
}

export interface ResolvedDomainOrder {
  domain: string;
  source: string | null;
  accountLabel: string | null;
  ok: boolean;          // provider has a credential for this domain's account
  reason: string | null;
  inboxing?: { registrarCredentialId: string; cloudflareCredentialId: string };
  milkbox?: { domainProviderId: string };
  scaledmail?: { username: string; password: string };
}

/** Resolve each domain's provider credential from its Porkbun account. */
export async function resolveDomainOrders(
  domains: string[],
  provider: InboxOrderProvider,
): Promise<Map<string, ResolvedDomainOrder>> {
  const supabase = getSupabaseAdmin();
  const norm = Array.from(new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean)));

  const sourceByDomain = new Map<string, string>();
  for (let i = 0; i < norm.length; i += 300) {
    const slice = norm.slice(i, i + 300);
    const { data } = await supabase.from("domain_inventory").select("domain, source").in("domain", slice);
    for (const r of data || []) sourceByDomain.set((r.domain as string).toLowerCase(), r.source as string);
  }

  const out = new Map<string, ResolvedDomainOrder>();
  for (const d of norm) {
    const source = sourceByDomain.get(d) ?? null;
    const accountLabel = source ? (PORKBUN_ACCOUNT_LABEL[source] ?? source) : null;
    const base: ResolvedDomainOrder = { domain: d, source, accountLabel, ok: false, reason: null };

    if (!source) {
      out.set(d, { ...base, reason: "not in the All Domains inventory — run Refresh Porkbun" });
      continue;
    }

    if (provider === "inboxing") {
      const registrarCredentialId = inboxingRegistrarFor(source);
      if (registrarCredentialId) out.set(d, { ...base, ok: true, inboxing: { registrarCredentialId, cloudflareCredentialId: INBOXING_CLOUDFLARE_CREDENTIAL_ID } });
      else out.set(d, { ...base, reason: `no Inboxing registrar mapped for "${accountLabel}"` });
    } else if (provider === "milkbox") {
      const domainProviderId = milkboxProviderFor(source);
      if (domainProviderId) out.set(d, { ...base, ok: true, milkbox: { domainProviderId } });
      else out.set(d, { ...base, reason: `no MilkBox domain provider mapped for "${accountLabel}" (set MILKBOX_DOMAIN_PROVIDER_${source === "porkbun_spencersellstech" ? "SPENCERSELLSTECH" : "OUTBOUNDHERO"})` });
    } else {
      const hosting = scaledmailHostingFor(source);
      if (hosting) out.set(d, { ...base, ok: true, scaledmail: hosting });
      else out.set(d, { ...base, reason: `no ScaledMail Porkbun login for "${accountLabel}" (set SCALEDMAIL_PORKBUN_USERNAME_${source === "porkbun_spencersellstech" ? "SPENCERSELLSTECH" : "OUTBOUNDHERO"} / _PASSWORD)` });
    }
  }
  return out;
}
