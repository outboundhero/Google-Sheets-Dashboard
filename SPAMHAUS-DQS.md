# Spamhaus DQS blacklist automation — how it works

A self-contained guide to the Spamhaus **DBL** (Domain Block List) check via a
**DQS** (Data Query Service) key. Hand this whole file to another dev / Claude
Code — the only file that must be ported is the resolver at the bottom, which
depends on nothing but Node's built-in `node:dns`.

---

## 1. The one insight that makes DQS necessary

Spamhaus's DBL is queried over **DNS**, not HTTP. You resolve `<domain>.<zone>`
as an A record and read the answer:

| DNS answer            | Meaning                                             |
|-----------------------|-----------------------------------------------------|
| **NXDOMAIN** (no record) | domain is **clean**                              |
| **`127.0.1.X`**       | domain is **listed**; last byte `X` = category code |
| **`127.255.255.X`**   | **access denied / rate-limited** — an error, NOT a listing |

The catch: the free public zone `dbl.spamhaus.org` **blocks queries from public
resolvers** (Cloudflare 1.1.1.1, Quad9, Google 8.8.8.8). Every lookup returns
`127.255.255.254` ("anonymous query denied") → *every domain looks
inconclusive* and nothing is ever markable.

A Spamhaus **DQS key** fixes exactly this. You query a **keyed zone**:

```
Free (blocked):  <domain>.dbl.spamhaus.org
DQS  (allowed):  <domain>.<KEY>.dbl.dq.spamhaus.net
```

The keyed zone is allowed through public resolvers **and returns the identical
`127.0.1.X` / `127.255.255.X` response format** — so the decode logic is
unchanged. That's the whole trick.

```ts
const DQS_KEY = process.env.SPAMHAUS_DQS_KEY?.trim();
const ZONE = DQS_KEY ? `${DQS_KEY}.dbl.dq.spamhaus.net` : "dbl.spamhaus.org";
```

Set `SPAMHAUS_DQS_KEY` → keyed zone works. Leave it unset → falls back to the
blocked free zone and everything reads inconclusive. **This env var is setup
step #1.**

> ⚠️ Account-type gotcha: the DQS key must come from an account that permits
> your query volume. Ours is an **individual (non-organisation)** DQS account.

---

## 2. The three-state result model (the most important rule)

```ts
blacklisted: boolean | null   // true = listed, false = clean, null = INCONCLUSIVE
```

`null` = "we could not get a trustworthy verdict" (denial code, timeout,
SERVFAIL…). **Never write `null` to the DB.** Leave the previous value untouched
and let the next run retry. This is what stops a rate-limited run from silently
flipping a whole batch of domains to "clean." Treat `null` as *"don't know, try
later,"* never as clean.

---

## 3. Decoding the response

```ts
const CODE_TO_CATEGORY = {
  2:"SPAM", 4:"PHISH", 5:"MALWARE", 6:"BOTNET_CC",
  102:"ABUSED_SPAM", 103:"ABUSED_REDIRECTOR", 104:"ABUSED_PHISH",
  105:"ABUSED_MALWARE", 106:"ABUSED_BOTNET_CC",
};
```

- `127.0.1.X` → **listed**; unknown code → still listed as `CODE_<n>` (over-flag
  is safer than false-clean).
- `127.255.255.X` → **denied/inconclusive**.
- Anything else inside `127/8` → **inconclusive**, never asserted clean.

---

## 4. Resolver-server selection (a real footgun)

```ts
const RESOLVER_SERVERS = ["1.1.1.1", "1.0.0.1", "9.9.9.9", "149.112.112.112"];
```

For **DBL/DQS** pin to **Cloudflare + Quad9**. **Do NOT use Google 8.8.8.8** — it
silently converts denial codes into NXDOMAIN, which would read as false "clean."
Cloudflare surfaces the denial honestly.

(The sibling **SURBL** list is the opposite: Cloudflare drops SURBL queries, so
that resolver uses Google 8.8.8.8. Don't copy one list's server set into the
other.)

---

## 5. Timeouts + one retry

```ts
const PER_RESOLVE_TIMEOUT_MS = 3000;   // per DNS attempt
const RETRY_DELAY_MS = 500;
const TRANSIENT_DNS_ERRORS = new Set(["ETIMEOUT","ESERVFAIL","EREFUSED","ECONNRESET"]);
```

`checkSpamhausDbl(domain)` flow:
1. Resolve `<domain>.<ZONE>` (3s timeout).
2. `ENOTFOUND` / `ENODATA` (NXDOMAIN) → **clean** (`false`).
3. Any decoded `denied` → **inconclusive** (`null`).
4. Any `listed` → **true** + joined category string.
5. Transient DNS error → wait 500ms, retry **once**; two in a row → `null`.

---

## 6. Preflight access check

`verifySpamhausAccess()` resolves Spamhaus's known-listed test point
`dbltest.com.<ZONE>`:
- comes back **listed** → access works.
- comes back **denied / NXDOMAIN** → resolver is blocked (usually a missing or
  invalid DQS key).

Wire this into a health check so a bad key **fails loudly** instead of silently
marking every domain clean.

---

## 7. Batch / persistence layer (thin wrapper around the resolver)

`POST /api/deliverability/check-spamhaus  { domains: string[] }`:

1. Normalize + dedupe (lowercase, trim).
2. Look up existing rows so the same domain across workspaces all update.
3. Run **100 concurrent** checks (`Promise.allSettled` — DNS is I/O-bound).
4. **Only upsert definite results** (`blacklisted !== null`); skip inconclusive
   so they retry next run.
5. Idempotent upsert writing `spamhaus_dbl` + `spamhaus_checked_at`.
6. Return `{ checked, listed, inconclusive, updated }`.

`maxDuration = 60`; large scans are driven by the frontend calling this in
chunks. **There is no cron — it's a user/bulk-op-triggered flow.** Persistence
(Supabase / Redis) is swappable; only the resolver is essential.

---

## 8. Minimal setup checklist for a new app

1. Get a **Spamhaus DQS account/key** → set `SPAMHAUS_DQS_KEY`. Without it the
   code runs but returns all-inconclusive.
2. **Only dependency is Node's built-in `node:dns`** — the resolver is
   standalone.
3. **Pin resolvers to Cloudflare/Quad9 for DBL** (`1.1.1.1`, `9.9.9.9`) — not
   Google, or you get false cleans.
4. **Honor the three-state model** — never persist `null`; leave old value +
   retry.
5. Query the **keyed zone** `<domain>.<KEY>.dbl.dq.spamhaus.net`; decode
   `127.0.1.X` = listed / `127.255.255.X` = denied / NXDOMAIN = clean.
6. Optionally wire the `dbltest.com` preflight into a health check.

---

## 9. The full resolver (drop-in, only depends on `node:dns`)

```ts
import { promises as dns } from "node:dns";

// Spamhaus Domain Block List (DBL). NXDOMAIN = clean. 127.0.1.X = listed
// (the last byte names the category). 127.255.255.X = access denied
// (anonymous query via public resolver, rate limit, etc.) — treat as
// inconclusive so we never mis-mark a denied query as "clean".
//
// The public zone `dbl.spamhaus.org` BLOCKS queries from public resolvers
// (Cloudflare/Quad9/Google) → every lookup returns 127.255.255.254 ("denied")
// → everything is inconclusive. The fix is a Spamhaus DQS key: with one set,
// we query the keyed zone `<KEY>.dbl.dq.spamhaus.net`, which Spamhaus allows
// via public resolvers and which returns the same 127.0.1.X listing codes.
// Same response format → the decode() logic below is unchanged.
const DQS_KEY = process.env.SPAMHAUS_DQS_KEY?.trim();
const ZONE = DQS_KEY ? `${DQS_KEY}.dbl.dq.spamhaus.net` : "dbl.spamhaus.org";
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
```

---

## 10. Example batch usage

```ts
import { checkSpamhausDbl, verifySpamhausAccess } from "./spamhaus-dbl-resolver";

// Health check first — bail if the key/resolver is blocked.
const access = await verifySpamhausAccess();
if (!access.ok) throw new Error(`Spamhaus unreachable: ${access.reason}`);

const CONCURRENT = 100;
const definite = new Map<string, boolean>(); // domain → listed
for (let i = 0; i < domains.length; i += CONCURRENT) {
  const batch = domains.slice(i, i + CONCURRENT);
  const settled = await Promise.allSettled(batch.map((d) => checkSpamhausDbl(d)));
  batch.forEach((d, j) => {
    const r = settled[j];
    const res = r.status === "fulfilled" ? r.value : null;
    if (res && res.blacklisted !== null) definite.set(d, res.blacklisted); // skip nulls!
  });
}
// Persist ONLY `definite` — inconclusive domains keep their old value and retry.
```
