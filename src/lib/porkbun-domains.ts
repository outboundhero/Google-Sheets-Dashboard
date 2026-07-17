// Multi-account Porkbun helpers for the deliverability "Domains" section.
// The existing porkbun.ts is single-account (PORKBUN_API_KEY) and its `call()`
// reads json.response; listAll/pricing put data at the TOP level, so these are
// dedicated helpers that also support a second account.

const BASE = "https://api.porkbun.com/api/json/v3";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PorkbunAccount {
  label: string;
  apikey: string;
  secretapikey: string;
}

export interface PorkbunDomainRow {
  domain: string;
  tld: string;
  status: string;
  expireDate: string; // "YYYY-MM-DD HH:MM:SS"
  autoRenew: number;  // 0 | 1
}

/** Configured Porkbun accounts (skips any whose keys are absent). */
export function porkbunAccounts(): PorkbunAccount[] {
  const accts: PorkbunAccount[] = [];
  if (process.env.PORKBUN_API_KEY && process.env.PORKBUN_SECRET_API_KEY) {
    accts.push({ label: "Porkbun 1", apikey: process.env.PORKBUN_API_KEY, secretapikey: process.env.PORKBUN_SECRET_API_KEY });
  }
  if (process.env.PORKBUN_API_KEY_2 && process.env.PORKBUN_SECRET_API_KEY_2) {
    accts.push({ label: "Porkbun 2", apikey: process.env.PORKBUN_API_KEY_2, secretapikey: process.env.PORKBUN_SECRET_API_KEY_2 });
  }
  return accts;
}

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** All domains on `acct` whose renewal/redemption deadline is within `withinDays`. */
export async function listExpiringDomains(acct: PorkbunAccount, withinDays = 10): Promise<PorkbunDomainRow[]> {
  const all: PorkbunDomainRow[] = [];
  let start = 0;
  for (let guard = 0; guard < 100; guard++) {
    const res = await post("/domain/listAll", {
      apikey: acct.apikey,
      secretapikey: acct.secretapikey,
      start,
      expiringWithinDays: String(withinDays),
    });
    if (!res.ok) throw new Error(`Porkbun listAll (${acct.label}): HTTP ${res.status}`);
    const json = await res.json();
    if (json.status !== "SUCCESS") throw new Error(`Porkbun listAll (${acct.label}): ${json.message || "error"}`);
    const chunk: PorkbunDomainRow[] = json.domains || [];
    all.push(...chunk);
    if (chunk.length < 1000) break; // last chunk
    start += 1000;
  }
  return all;
}

/** TLD → yearly renewal price (USD). No auth required. */
export async function getRenewalPricing(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const res = await post("/pricing/get", {});
  if (!res.ok) return map;
  const json = await res.json().catch(() => null);
  const pricing = json?.pricing || {};
  for (const tld of Object.keys(pricing)) {
    const r = parseFloat(pricing[tld]?.renewal);
    if (Number.isFinite(r)) map.set(tld.toLowerCase(), r);
  }
  return map;
}

/** Turn auto-renew on/off for one domain, with patient retry on 429/5xx. */
export async function updateAutoRenew(acct: PorkbunAccount, domain: string, enabled: boolean): Promise<void> {
  const status = enabled ? "on" : "off";
  let lastErr = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await post(`/domain/updateAutoRenew/${encodeURIComponent(domain)}`, {
        apikey: acct.apikey,
        secretapikey: acct.secretapikey,
        status,
      });
      if (res.ok) {
        const json = await res.json().catch(() => null);
        if (!json || json.status === "SUCCESS") return;
        lastErr = json.message || "Porkbun returned ERROR"; // 200 + ERROR — retry a couple times
      } else if (res.status === 429 || res.status >= 500) {
        lastErr = `HTTP ${res.status}`;
        const ra = parseInt(res.headers.get("retry-after") || "", 10);
        await delay(Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(10_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 300));
        continue;
      } else {
        const t = await res.text().catch(() => "");
        throw new Error(`Porkbun updateAutoRenew ${res.status}: ${t.slice(0, 150)}`);
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : "request failed";
    }
    if (attempt < 3) await delay(1000 * (attempt + 1));
  }
  throw new Error(lastErr || "updateAutoRenew failed");
}
