import { promises as dns } from "node:dns";

// SURBL multi zone. NXDOMAIN = clean. 127.0.0.X = listed (last byte is a
// bitmask of which categories). 127.0.0.255 specifically signals the resolver
// has been rate-limited by SURBL — treat as inconclusive, not as "clean".
const SURBL_ZONE = "multi.surbl.org";
const TOTAL_BUDGET_MS = 5000;
// Pin to resolvers known to answer RBL queries (Cloudflare 1.1.1.1 silently
// drops them in practice). Google primary + Google secondary + Quad9 fallback.
const RESOLVER_SERVERS = ["8.8.8.8", "8.8.4.4", "9.9.9.9", "149.112.112.112"];

const resolver = new dns.Resolver();
resolver.setServers(RESOLVER_SERVERS);

export interface BlacklistResult {
  domain: string;
  /** true = listed, false = clean, null = inconclusive (rate-limit / DNS error). */
  blacklisted: boolean | null;
  /** When listed, which SURBL categories were flagged. */
  lists: string[];
  error: string | null;
}

function decodeBits(lastByte: number): string[] {
  const flags: string[] = [];
  if (lastByte & 8) flags.push("PHISH");
  if (lastByte & 16) flags.push("MALWARE");
  if (lastByte & 32) flags.push("ABUSE");
  if (lastByte & 64) flags.push("CRACKED");
  return flags;
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

export async function checkBlacklist(rawDomain: string): Promise<BlacklistResult> {
  const domain = rawDomain.trim().toLowerCase();
  const host = `${domain}.${SURBL_ZONE}`;
  try {
    const ips = await withTimeout(resolver.resolve4(host), TOTAL_BUDGET_MS);
    if (!ips || ips.length === 0) {
      return { domain, blacklisted: false, lists: [], error: null };
    }
    const lastBytes = ips
      .map((ip) => Number(ip.split(".").pop()))
      .filter((n) => Number.isFinite(n));
    if (lastBytes.some((b) => b === 255)) {
      return {
        domain,
        blacklisted: null,
        lists: [],
        error: "SURBL rate-limited this resolver (127.0.0.255)",
      };
    }
    const set = new Set<string>();
    for (const b of lastBytes) for (const f of decodeBits(b)) set.add(f);
    return { domain, blacklisted: true, lists: Array.from(set), error: null };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOTFOUND" || code === "ENODATA") {
      return { domain, blacklisted: false, lists: [], error: null };
    }
    return {
      domain,
      blacklisted: null,
      lists: [],
      error: `DNS error: ${e instanceof Error ? e.message : "unknown"}`.slice(0, 200),
    };
  }
}
