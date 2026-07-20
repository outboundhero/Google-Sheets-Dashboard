import { NextResponse } from "next/server";
import { listAllDomainNamesPage } from "@/lib/porkbun-domains";

// GET /api/domains/porkbun-account-check  (admin-only via middleware)
//
// Verifies, from Vercel's REAL env values, which Porkbun ACCOUNT each configured
// key pair resolves to — WITHOUT ever returning the key values. It paginates the
// account's domain list and looks for marker domains unique to each account:
//   outboundhero    → skytabbilling.com / facilityreach.com / smartjanitorsolutions.com
//   spencersellstech→ dm4pm.info / satininsurance.com / outboundherogrowth.com
// Use this once after deploy to confirm the buyer (PORKBUN_OUTBOUNDHERO_*) is
// pointed at outboundhero and to catch a mis-pointed slot.
export const maxDuration = 60;

const MARKERS: Record<"outboundhero" | "spencersellstech", string[]> = {
  outboundhero: ["skytabbilling.com", "facilityreach.com", "smartjanitorsolutions.com"],
  spencersellstech: ["dm4pm.info", "satininsurance.com", "outboundherogrowth.com"],
};

const ENV_PAIRS: { envVar: string; keyEnv: string; secretEnv: string }[] = [
  { envVar: "PORKBUN_OUTBOUNDHERO_API_KEY", keyEnv: "PORKBUN_OUTBOUNDHERO_API_KEY", secretEnv: "PORKBUN_OUTBOUNDHERO_SECRET_API_KEY" },
  { envVar: "PORKBUN_SPENCERSELLSTECH_API_KEY", keyEnv: "PORKBUN_SPENCERSELLSTECH_API_KEY", secretEnv: "PORKBUN_SPENCERSELLSTECH_SECRET_API_KEY" },
  { envVar: "PORKBUN_API_KEY (legacy)", keyEnv: "PORKBUN_API_KEY", secretEnv: "PORKBUN_SECRET_API_KEY" },
  { envVar: "PORKBUN_API_KEY_2 (legacy)", keyEnv: "PORKBUN_API_KEY_2", secretEnv: "PORKBUN_SECRET_API_KEY_2" },
];

const MAX_PAGES = 12;
const PAGE_DELAY_MS = 600;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ProbeResult {
  resolvesTo: "outboundhero" | "spencersellstech" | "unknown";
  markerMatched: string | null;
  scanned: number;
  sample: string[];
  error?: string;
}

async function probe(apikey: string, secretapikey: string): Promise<ProbeResult> {
  let scanned = 0;
  let sample: string[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await delay(PAGE_DELAY_MS);
    let names: string[];
    try {
      names = await listAllDomainNamesPage(apikey, secretapikey, page * 1000);
    } catch (e) {
      return {
        resolvesTo: "unknown",
        markerMatched: null,
        scanned,
        sample,
        error: e instanceof Error ? e.message : "probe failed",
      };
    }
    if (page === 0) sample = names.slice(0, 6);
    scanned += names.length;
    const set = new Set(names.map((n) => n.toLowerCase()));
    for (const acct of ["outboundhero", "spencersellstech"] as const) {
      const hit = MARKERS[acct].find((m) => set.has(m));
      if (hit) return { resolvesTo: acct, markerMatched: hit, scanned, sample };
    }
    if (names.length < 1000) break; // exhausted
  }
  return { resolvesTo: "unknown", markerMatched: null, scanned, sample };
}

export async function GET() {
  // Probe each UNIQUE key value once (in parallel across distinct accounts),
  // then map the verdict back onto every env-var name that shares that key.
  const configured = ENV_PAIRS.map((p) => ({
    ...p,
    apikey: process.env[p.keyEnv],
    secretapikey: process.env[p.secretEnv],
  }));

  const uniqueKeys = new Map<string, { apikey: string; secretapikey: string }>();
  for (const c of configured) {
    if (c.apikey && c.secretapikey && !uniqueKeys.has(c.apikey)) {
      uniqueKeys.set(c.apikey, { apikey: c.apikey, secretapikey: c.secretapikey });
    }
  }

  const probeByKey = new Map<string, ProbeResult>();
  await Promise.all(
    Array.from(uniqueKeys.entries()).map(async ([key, creds]) => {
      probeByKey.set(key, await probe(creds.apikey, creds.secretapikey));
    })
  );

  const results = configured.map((c) => {
    if (!c.apikey || !c.secretapikey) {
      return { envVar: c.envVar, configured: false, resolvesTo: null as string | null };
    }
    const r = probeByKey.get(c.apikey)!;
    return {
      envVar: c.envVar,
      configured: true,
      resolvesTo: r.resolvesTo,
      markerMatched: r.markerMatched,
      scanned: r.scanned,
      sampleDomains: r.sample,
      error: r.error,
    };
  });

  const buyAccount = results.find((r) => r.envVar === "PORKBUN_OUTBOUNDHERO_API_KEY");
  const buyerSafe = buyAccount?.configured === true && buyAccount.resolvesTo === "outboundhero";

  return NextResponse.json({
    buyerSafe,
    buyAccountResolvesTo: buyAccount?.resolvesTo ?? null,
    note: buyerSafe
      ? "Buyer is correctly pointed at the outboundhero account."
      : "Buyer is NOT confirmed on outboundhero — set PORKBUN_OUTBOUNDHERO_* to the outboundhero key (holds skytab/facilityreach).",
    results,
  });
}
