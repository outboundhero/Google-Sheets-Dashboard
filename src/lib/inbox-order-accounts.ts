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

// ── MilkBox ───────────────────────────────────────────────────────────────
// domain_provider_id UUIDs from GET /api/v1/domain-providers (hardcoded; env-
// overridable). "Previous Porkbun" is assumed = spencersellstech (only other
// Porkbun provider on the account) — confirm with the team.
const MILKBOX_PROVIDER_BY_SOURCE: Record<string, string> = {
  porkbun_outboundhero: "98fd7218-1efe-4acd-9209-a30678d8afdf",     // "OutboundHero Porkbun"
  porkbun_spencersellstech: "b016befe-a7af-4e63-a687-f130646bad70", // "Previous Porkbun"
};
function milkboxProviderFor(source: string | null): string | null {
  if (!source) return null;
  const env: Record<string, string | undefined> = {
    porkbun_outboundhero: process.env.MILKBOX_DOMAIN_PROVIDER_OUTBOUNDHERO,
    porkbun_spencersellstech: process.env.MILKBOX_DOMAIN_PROVIDER_SPENCERSELLSTECH,
  };
  return env[source] || MILKBOX_PROVIDER_BY_SOURCE[source] || process.env.MILKBOX_DOMAIN_PROVIDER_ID || null;
}

// sequencer_id UUIDs from GET /api/v1/sequencers — one per Bison instance.
const MILKBOX_SEQUENCER_BY_INSTANCE: Record<string, string> = {
  outboundhero: "465c2e62-3a9c-4c89-854b-234fcb388eb9",   // "OutboundHero EmailBison"
  cleaningoutbound: "eab5134e-418c-48da-8d57-027b0e22ded4", // "CleaningOutbound (B2C #1)"
  facilityreach: "ee6bf048-c384-4c08-a7ae-00667e44ca60",  // "FacilityReach (B2B #2)"
  outboundclean: "23c11aa5-25ab-4f13-8e86-98445f88a477",  // "OutboundClean (B2C #2)"
};
/** MilkBox sequencer for the order's Bison instance (env-overridable). */
export function milkboxSequencerFor(instance: string): string | null {
  const env: Record<string, string | undefined> = {
    outboundhero: process.env.MILKBOX_SEQUENCER_OUTBOUNDHERO,
    cleaningoutbound: process.env.MILKBOX_SEQUENCER_CLEANINGOUTBOUND,
    facilityreach: process.env.MILKBOX_SEQUENCER_FACILITYREACH,
    outboundclean: process.env.MILKBOX_SEQUENCER_OUTBOUNDCLEAN,
  };
  return env[instance] || MILKBOX_SEQUENCER_BY_INSTANCE[instance] || process.env.MILKBOX_SEQUENCER_ID || null;
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
