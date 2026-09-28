const BASE = "https://api.porkbun.com/api/json/v3";

/**
 * Which Porkbun account a buy/check/auto-renew call runs against.
 *
 * Spencer, when he handed the credentials over: "We want to be able to select
 * and use spencer@spencersellstech.com as well (please make this the default)."
 * Hence `DEFAULT_BUY_ACCOUNT` below — spencersellstech, not outboundhero.
 */
export type PorkbunAccountKey = "outboundhero" | "spencersellstech";

export const PORKBUN_ACCOUNT_KEYS: PorkbunAccountKey[] = ["outboundhero", "spencersellstech"];

/** Spencer's requested default. Changing this changes where money is spent. */
export const DEFAULT_BUY_ACCOUNT: PorkbunAccountKey = "spencersellstech";

/** Human label for the UI. */
export const PORKBUN_ACCOUNT_LABELS: Record<PorkbunAccountKey, string> = {
  outboundhero: "outboundhero",
  spencersellstech: "spencersellstech",
};

/**
 * `domain_inventory.source` value for each account — the same strings
 * `inbox-order-accounts.ts` keys its registrar-credential map on, so a domain
 * bought here resolves to the right Inboxing/MilkBox/ScaledMail credential.
 */
export const PORKBUN_ACCOUNT_SOURCE: Record<PorkbunAccountKey, string> = {
  outboundhero: "porkbun_outboundhero",
  spencersellstech: "porkbun_spencersellstech",
};

export function isPorkbunAccountKey(v: unknown): v is PorkbunAccountKey {
  return typeof v === "string" && (PORKBUN_ACCOUNT_KEYS as string[]).includes(v);
}

/** Narrow an untrusted value to an account key, falling back to the default. */
export function resolveBuyAccount(v: unknown): PorkbunAccountKey {
  return isPorkbunAccountKey(v) ? v : DEFAULT_BUY_ACCOUNT;
}

const ENV_BY_ACCOUNT: Record<PorkbunAccountKey, { key: string; secret: string }> = {
  outboundhero: { key: "PORKBUN_OUTBOUNDHERO_API_KEY", secret: "PORKBUN_OUTBOUNDHERO_SECRET_API_KEY" },
  spencersellstech: { key: "PORKBUN_SPENCERSELLSTECH_API_KEY", secret: "PORKBUN_SPENCERSELLSTECH_SECRET_API_KEY" },
};

/**
 * Credentials for one named account.
 *
 * Still **fails closed**: every account reads its own explicitly-named env pair
 * and throws when absent. There is deliberately NO fallback to the legacy
 * `PORKBUN_API_KEY` — that key's account identity is not guaranteed, and buying
 * on the wrong account is unrecoverable. The account is always passed in
 * explicitly by the caller (stored per queue row), never inferred at call time.
 */
function creds(account: PorkbunAccountKey) {
  const env = ENV_BY_ACCOUNT[account];
  const apikey = process.env[env.key];
  const secretapikey = process.env[env.secret];
  if (!apikey || !secretapikey) {
    throw new Error(
      `${account} Porkbun keys missing (${env.key} / ${env.secret}). ` +
        "The buyer refuses to run without them so it can never buy on the wrong account."
    );
  }
  return { apikey, secretapikey };
}

/** Which accounts actually have credentials configured, for the UI picker. */
export function configuredBuyAccounts(): PorkbunAccountKey[] {
  return PORKBUN_ACCOUNT_KEYS.filter((a) => {
    const env = ENV_BY_ACCOUNT[a];
    return Boolean(process.env[env.key] && process.env[env.secret]);
  });
}

interface PorkbunEnvelope<T> {
  status: "SUCCESS" | "ERROR";
  message?: string;
  response?: T;
  limits?: { TTL?: number; limit?: number; used?: number; naturalLanguage?: string };
  ttlRemaining?: number;
}

async function call<T>(path: string, body: Record<string, unknown>): Promise<PorkbunEnvelope<T>> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: PorkbunEnvelope<T>;
  try {
    json = (await res.json()) as PorkbunEnvelope<T>;
  } catch {
    throw new Error(`Porkbun ${path} returned non-JSON (HTTP ${res.status})`);
  }
  if (json.status !== "SUCCESS") {
    throw new Error(json.message || `Porkbun ${path} failed (HTTP ${res.status})`);
  }
  return json;
}

export interface CheckDomainResult {
  avail: boolean;
  type: string;
  price: number;
  regularPrice: number;
  premium: boolean;
  ttlRemaining: number;
  rateLimitNote: string;
}

export async function checkDomain(
  domain: string,
  account: PorkbunAccountKey = DEFAULT_BUY_ACCOUNT
): Promise<CheckDomainResult> {
  const json = await call<{
    avail: string;
    type: string;
    price: string;
    regularPrice: string;
    premium: string;
    minDuration: number;
  }>(`/domain/checkDomain/${encodeURIComponent(domain)}`, creds(account));
  const r = json.response;
  if (!r) throw new Error("Porkbun checkDomain returned no response payload");
  return {
    avail: r.avail === "yes",
    type: r.type,
    price: parseFloat(r.price),
    regularPrice: parseFloat(r.regularPrice),
    premium: r.premium === "yes",
    ttlRemaining: json.ttlRemaining ?? 0,
    rateLimitNote: json.limits?.naturalLanguage || "",
  };
}

/**
 * Register a domain on `account`. `priceUsd` is the registration price returned
 * earlier by checkDomain; we convert to integer cents for Porkbun's `cost` field
 * and pass `agreeToTerms: "yes"` per the v3 spec.
 */
export async function createDomain(
  domain: string,
  priceUsd: number,
  account: PorkbunAccountKey = DEFAULT_BUY_ACCOUNT
): Promise<void> {
  const cost = Math.round(priceUsd * 100);
  await call(`/domain/create/${encodeURIComponent(domain)}`, {
    ...creds(account),
    cost,
    agreeToTerms: "yes",
  });
}

export async function setAutoRenew(
  domain: string,
  enabled: boolean,
  account: PorkbunAccountKey = DEFAULT_BUY_ACCOUNT
): Promise<void> {
  await call(`/domain/updateAutoRenew/${encodeURIComponent(domain)}`, {
    ...creds(account),
    status: enabled ? "on" : "off",
  });
}
