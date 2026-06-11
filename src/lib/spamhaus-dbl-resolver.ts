import { promises as dns } from "node:dns";

// Spamhaus Domain Block List (DBL). NXDOMAIN = clean. 127.0.1.X = listed
// (the last byte names the category). 127.255.255.X = access denied
// (anonymous query via public resolver, rate limit, etc.) — treat as
// inconclusive so we never mis-mark a denied query as "clean".
const ZONE = "dbl.spamhaus.org";
const PER_RESOLVE_TIMEOUT_MS = 3000;
const RETRY_DELAY_MS = 500;
const TRANSIENT_DNS_ERRORS = new Set(["ETIMEOUT", "ESERVFAIL", "EREFUSED", "ECONNRESET"]);
// Cloudflare surfaces the denial code honestly (good — we want that signal),
// Quad9 sometimes lets queries through. Google 8.8.8.8 silently converts
// denials to NXDOMAIN, which would produce false-cleans — don't use.
const RESOLVER_SERVERS = ["1.1.1.1", "1.0.0.1", "9.9.9.9", "149.112.112.112"];
const TEST_POINT = "dbltest.com";

const resolver = new dns.Resolver();
resolver.setServers(RESOLVER_SERVERS);

export interface SpamhausResult {
  domain: string;
  /** true = listed, false = clean, null = inconclusive (denied / DNS error). */
  blacklisted: boolean | null;
  /** When listed, which Spamhaus category. */
  category: string | null;
  error: string | null;
}

const CODE_TO_CATEGORY: Record<number, string> = {
  2: "SPAM",
  4: "PHISH",
  5: "MALWARE",
  6: "BOTNET_CC",
  102: "ABUSED_SPAM",
  103: "ABUSED_REDIRECTOR",
  104: "ABUSED_PHISH",
  105: "ABUSED_MALWARE",
  106: "ABUSED_BOTNET_CC",
};

interface Decoded {
  listed: boolean;
  denied: boolean;
  category: string | null;
}

function decode(ip: string): Decoded {
  const o = ip.split(".").map(Number);
  if (o.length !== 4 || o[0] !== 127) {
    return { listed: false, denied: true, category: null };
  }
  // 127.0.1.X — real listing codes
  if (o[1] === 0 && o[2] === 1) {
    const code = o[3];
    const cat = CODE_TO_CATEGORY[code];
    if (cat) return { listed: true, denied: false, category: cat };
    // Unknown 127.0.1.X — could be a new Spamhaus code we don't know about.
    // Treat as listed (safer than clean) with category = raw code.
    return { listed: true, denied: false, category: `CODE_${code}` };
  }
  // 127.255.255.X — error / access-denied codes (252 = typo, 254 = anonymous
  // query denied, 255 = excessive queries, etc.).
  if (o[1] === 255 && o[2] === 255) {
    return { listed: false, denied: true, category: null };
  }
  // Anything else inside 127.0.0.0/8 — unexpected. Be conservative: treat as
  // denied/inconclusive rather than asserting "clean".
  return { listed: false, denied: true, category: null };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race<T>([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error("DNS timeout") as NodeJS.ErrnoException;
        err.code = "ETIMEOUT";
        reject(err);
      }, ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// One resolve attempt: returns the IP list, or throws an Error whose `.code`
// is either a DNS error code (ENOTFOUND, ETIMEOUT, …) or "" for unknown.
async function resolveOnce(host: string): Promise<string[]> {
  return withTimeout(resolver.resolve4(host), PER_RESOLVE_TIMEOUT_MS);
}

/**
 * Preflight: queries Spamhaus's known-listed test point (dbltest.com → spam).
 * Returns true iff the resolver gets the real answer through. Lets the caller
 * abort cleanly when Spamhaus is blocking us, so we never write a batch of
 * misleading "clean" rows.
 */
export async function verifySpamhausAccess(): Promise<{ ok: boolean; reason: string | null }> {
  try {
    const ips = await withTimeout(resolver.resolve4(`${TEST_POINT}.${ZONE}`), PER_RESOLVE_TIMEOUT_MS);
    if (!ips || ips.length === 0) {
      return { ok: false, reason: "Spamhaus returned no answer for the test point" };
    }
    const dec = decode(ips[0]);
    if (dec.listed) return { ok: true, reason: null };
    if (dec.denied) {
      return {
        ok: false,
        reason: `Spamhaus blocked the resolver (got ${ips[0]}). Their free DNS-based service doesn't allow anonymous queries via public resolvers; consider a Data Query Service (DQS) account.`,
      };
    }
    return { ok: false, reason: `Unexpected test-point response: ${ips[0]}` };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOTFOUND" || code === "ENODATA") {
      return {
        ok: false,
        reason:
          "Resolver returned NXDOMAIN for Spamhaus's test point — most likely the resolver is being blocked.",
      };
    }
    return {
      ok: false,
      reason: `DNS error verifying access: ${e instanceof Error ? e.message : "unknown"}`,
    };
  }
}

export async function checkSpamhausDbl(rawDomain: string): Promise<SpamhausResult> {
  const domain = rawDomain.trim().toLowerCase();
  const host = `${domain}.${ZONE}`;

  // Single attempt — returns null for "couldn't get a verdict, maybe retry"
  // or a final SpamhausResult.
  const attempt = async (): Promise<SpamhausResult | { retry: true; reason: string }> => {
    try {
      const ips = await resolveOnce(host);
      if (!ips || ips.length === 0) {
        return { domain, blacklisted: false, category: null, error: null };
      }
      const decs = ips.map(decode);
      // Refusal / rate-limit signal — never a real listing.
      if (decs.some((d) => d.denied)) {
        return {
          domain,
          blacklisted: null,
          category: null,
          error: `Spamhaus refused (${ips.join(",")})`,
        };
      }
      const hits = decs.filter((d) => d.listed);
      if (hits.length > 0) {
        const cats = Array.from(new Set(hits.map((h) => h.category).filter(Boolean) as string[]));
        return { domain, blacklisted: true, category: cats.join(","), error: null };
      }
      return { domain, blacklisted: false, category: null, error: null };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code || "";
      // NXDOMAIN / ENODATA = the domain is NOT on the list. Confirmed clean.
      if (code === "ENOTFOUND" || code === "ENODATA") {
        return { domain, blacklisted: false, category: null, error: null };
      }
      // Transient: one retry. Anything else is a final "unverified".
      if (TRANSIENT_DNS_ERRORS.has(code)) {
        return { retry: true, reason: `transient ${code}` };
      }
      return {
        domain,
        blacklisted: null,
        category: null,
        error: `DNS error: ${e instanceof Error ? e.message : "unknown"}`.slice(0, 200),
      };
    }
  };

  const first = await attempt();
  if ("retry" in first) {
    await sleep(RETRY_DELAY_MS);
    const second = await attempt();
    if ("retry" in second) {
      // Two transient failures in a row — give up as unverified, don't write.
      return { domain, blacklisted: null, category: null, error: `transient: ${second.reason}` };
    }
    return second;
  }
  return first;
}
