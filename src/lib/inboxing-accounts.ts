// Two Inboxing accounts (Spencer 2026-08-12). Same product, separate logins,
// separate slot pools, DIFFERENT IP geography — so an order must say which one
// it belongs to, and every later call about that domain (status poll, redirect
// change, tags, platform upload, delete) must use the SAME account's key or
// Inboxing answers 404.
//
//   premium = spencer@outboundhero.co      — Asia-based IPs  (the original)
//   regular = spencer@spencersellstech.com — US-based IPs    (added Aug 2026)
//
// "premium" keeps the legacy INBOXING_* env vars untouched so every existing
// order, cron and dashboard read keeps working exactly as before.
import type { BisonInstanceSlug } from "@/lib/bison-instances";

export type InboxingAccount = "premium" | "regular";

/** Legacy behaviour: anything that doesn't name an account is the old one. */
export const DEFAULT_INBOXING_ACCOUNT: InboxingAccount = "premium";

/** Spencer's wording — used verbatim in the UI. */
export const INBOXING_ACCOUNT_LABEL: Record<InboxingAccount, string> = {
  regular: "Inboxing – Regular Tenants",
  premium: "Inboxing – Premium Tenants",
};

export const INBOXING_ACCOUNT_LOGIN: Record<InboxingAccount, string> = {
  regular: "spencer@spencersellstech.com",
  premium: "spencer@outboundhero.co",
};

export const INBOXING_ACCOUNT_REGION: Record<InboxingAccount, string> = {
  regular: "US-based IPs",
  premium: "Asia-based IPs",
};

export function isInboxingAccount(v: unknown): v is InboxingAccount {
  return v === "premium" || v === "regular";
}

/** Porkbun account (domain_inventory.source) → that account's registrar credential. */
type RegistrarMap = Record<string, string | undefined>;

interface AccountConfig {
  apiKey: string | undefined;
  baseUrl: string;
  cloudflareCredentialId: string | undefined;
  registrars: RegistrarMap;
  /** Bison instance → Inboxing platform-connection id (where mailboxes land). */
  connections: Record<BisonInstanceSlug, string | undefined>;
}

// IDs fetched live from each account 2026-08-12 (GET /registrars,
// /cloudflare-credentials, /platform-connections — all verified). Env vars
// override so a re-created credential never needs a deploy.
function config(account: InboxingAccount): AccountConfig {
  if (account === "regular") {
    return {
      apiKey: process.env.INBOXING_REGULAR_API_KEY,
      baseUrl: process.env.INBOXING_REGULAR_BASE_URL || "https://v2.inboxing.com/api/v2",
      cloudflareCredentialId:
        process.env.INBOXING_REGULAR_CLOUDFLARE_CREDENTIAL_ID || "cmsnu46vd0005oasck0yfpahm",
      registrars: {
        porkbun_outboundhero:
          process.env.INBOXING_REGULAR_REGISTRAR_OUTBOUNDHERO || "cmsnu46v70003oasc15rbh1et",
        porkbun_spencersellstech:
          process.env.INBOXING_REGULAR_REGISTRAR_SPENCERSELLSTECH || "cmsnu46v30001oascb19z1hqj",
      },
      connections: {
        outboundhero: process.env.INBOXING_REGULAR_CONNECTION_OUTBOUNDHERO || "cmsnu46vo0009oascrgec6d7e",
        cleaningoutbound: process.env.INBOXING_REGULAR_CONNECTION_CLEANINGOUTBOUND || "cmsnu46vs000boasck05tdlwt",
        facilityreach: process.env.INBOXING_REGULAR_CONNECTION_FACILITYREACH || "cmsnu46vw000doascpqevkpdl",
        outboundclean: process.env.INBOXING_REGULAR_CONNECTION_OUTBOUNDCLEAN || "cmsnu46w0000foascx2aeo3yo",
      },
    };
  }
  return {
    apiKey: process.env.INBOXING_API_KEY,
    baseUrl: process.env.INBOXING_BASE_URL || "https://v2.inboxing.com/api/v2",
    cloudflareCredentialId:
      process.env.INBOXING_CLOUDFLARE_CREDENTIAL_ID || "cmk5vg3ar03rxn001wt6fbm62",
    registrars: {
      porkbun_outboundhero: process.env.INBOXING_REGISTRAR_OUTBOUNDHERO || "cmnga698v28nllo01fenxvzfw",
      porkbun_spencersellstech: process.env.INBOXING_REGISTRAR_SPENCERSELLSTECH || "cmpeijttad93eoe015paoqgkb",
    },
    connections: {
      outboundhero: process.env.INBOXING_CONNECTION_OUTBOUNDHERO || "cmk65pnoa000bnw01xuq1ez9i",
      cleaningoutbound: process.env.INBOXING_CONNECTION_CLEANINGOUTBOUND || "cmpfr4kwvepbgoe017k8d28k3",
      facilityreach: process.env.INBOXING_CONNECTION_FACILITYREACH || "cmpfr2pv1epbcoe01oh86bgr7",
      outboundclean: process.env.INBOXING_CONNECTION_OUTBOUNDCLEAN || "cmpfr5y6oepbioe01u5kbq40p",
    },
  };
}

/** API key + base URL for an account. Throws only when the key is missing. */
export function inboxingAuth(account: InboxingAccount = DEFAULT_INBOXING_ACCOUNT): { key: string; base: string } {
  const c = config(account);
  if (!c.apiKey) {
    throw new Error(
      account === "regular"
        ? "Inboxing env missing (INBOXING_REGULAR_API_KEY) — add it in Vercel to use the Regular Tenants account"
        : "Inboxing env missing (INBOXING_API_KEY)",
    );
  }
  return { key: c.apiKey, base: c.baseUrl };
}

/** Is this account usable right now (key configured)? Drives the UI picker. */
export function inboxingAccountConfigured(account: InboxingAccount): boolean {
  return Boolean(config(account).apiKey);
}

export function inboxingCloudflareCredential(account: InboxingAccount = DEFAULT_INBOXING_ACCOUNT): string | undefined {
  return config(account).cloudflareCredentialId;
}

/** Registrar credential for the domain's Porkbun account, within this account. */
export function inboxingRegistrarCredential(
  account: InboxingAccount,
  porkbunSource: string | null,
): string | undefined {
  if (!porkbunSource) return undefined;
  return config(account).registrars[porkbunSource];
}

/** Platform-connection id that routes mailboxes to a Bison instance. */
export function inboxingConnectionFor(
  instance: BisonInstanceSlug,
  account: InboxingAccount = DEFAULT_INBOXING_ACCOUNT,
): string {
  return config(account).connections[instance] || "";
}

// ── Redirect mode (Spencer 2026-08-12) ──────────────────────────────────────
// Both accounts now default to Cloudflare Domain Masking. The one exception is
// JAN-PRO: their site can't be framed, so those keep a plain redirect.
const REGULAR_REDIRECT_HOSTS = ["jan-pro.com"];

export type InboxingRedirectType = "NONE" | "MASKED" | "REGULAR";

/** MASKED for everything except jan-pro.com destinations; NONE when no URL. */
export function inboxingRedirectType(redirectUrl: string | null | undefined): InboxingRedirectType {
  if (!redirectUrl || !redirectUrl.trim()) return "NONE";
  const u = redirectUrl.toLowerCase();
  return REGULAR_REDIRECT_HOSTS.some((h) => u.includes(h)) ? "REGULAR" : "MASKED";
}
