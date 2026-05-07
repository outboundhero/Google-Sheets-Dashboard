const BASE = "https://api.porkbun.com/api/json/v3";

function creds() {
  const apikey = process.env.PORKBUN_API_KEY;
  const secretapikey = process.env.PORKBUN_SECRET_API_KEY;
  if (!apikey || !secretapikey) {
    throw new Error("Porkbun API keys missing (PORKBUN_API_KEY / PORKBUN_SECRET_API_KEY)");
  }
  return { apikey, secretapikey };
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

export async function checkDomain(domain: string): Promise<CheckDomainResult> {
  const json = await call<{
    avail: string;
    type: string;
    price: string;
    regularPrice: string;
    premium: string;
    minDuration: number;
  }>(`/domain/checkDomain/${encodeURIComponent(domain)}`, creds());
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
 * Register a domain. `priceUsd` is the registration price returned earlier by
 * checkDomain; we convert to integer cents for Porkbun's `cost` field and pass
 * `agreeToTerms: "yes"` per the v3 spec.
 */
export async function createDomain(domain: string, priceUsd: number): Promise<void> {
  const cost = Math.round(priceUsd * 100);
  await call(`/domain/create/${encodeURIComponent(domain)}`, {
    ...creds(),
    cost,
    agreeToTerms: "yes",
  });
}

export async function setAutoRenew(domain: string, enabled: boolean): Promise<void> {
  await call(`/domain/updateAutoRenew/${encodeURIComponent(domain)}`, {
    ...creds(),
    status: enabled ? "on" : "off",
  });
}
