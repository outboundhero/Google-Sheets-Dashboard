import { promises as dns } from "node:dns";

// Resolves a domain's email provider from its MX records. Modeled on
// blacklist-resolver.ts: pinned resolvers + a hard timeout, and `provider: null`
// for inconclusive (DNS error/timeout) so callers never cache a wrong answer.

const TOTAL_BUDGET_MS = 4000;
const RESOLVER_SERVERS = ["8.8.8.8", "8.8.4.4", "1.1.1.1", "1.0.0.1"];

const resolver = new dns.Resolver();
resolver.setServers(RESOLVER_SERVERS);

export type MxProvider = "google" | "outlook" | "zoho" | "other" | "parked";

export interface MxResult {
  domain: string;
  /** null = inconclusive (DNS error/timeout) — do NOT cache. */
  provider: MxProvider | null;
  hosts: string[];
  error: string | null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race<T>([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error("DNS timeout")), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function classify(hosts: string[]): MxProvider {
  if (hosts.length === 0) return "parked";
  const h = hosts.join(" ");
  if (/(^|\.)aspmx\.l\.google\.com|\.google\.com|googlemail\.com/.test(h)) return "google";
  if (/\.mail\.protection\.outlook\.com|\.olc\.protection\.outlook\.com|(^|\.)outlook\.com/.test(h)) return "outlook";
  if (/zoho/.test(h)) return "zoho";
  return "other";
}

export async function resolveMxProvider(rawDomain: string): Promise<MxResult> {
  const domain = rawDomain.trim().toLowerCase();
  try {
    const records = await withTimeout(resolver.resolveMx(domain), TOTAL_BUDGET_MS);
    const hosts = (records || [])
      .map((r) => (r.exchange || "").trim().toLowerCase())
      .filter(Boolean);
    return { domain, provider: classify(hosts), hosts, error: null };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    // No MX / no such domain ⇒ not receiving mail ⇒ parked (a definite answer).
    if (code === "ENOTFOUND" || code === "ENODATA") {
      return { domain, provider: "parked", hosts: [], error: null };
    }
    // Transient (timeout / SERVFAIL / refused) ⇒ inconclusive, retry next pass.
    return {
      domain,
      provider: null,
      hosts: [],
      error: `DNS error: ${e instanceof Error ? e.message : "unknown"}`.slice(0, 200),
    };
  }
}
