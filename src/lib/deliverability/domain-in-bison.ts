// "Is this domain actually in this Bison instance?" — asked of BISON, not of
// our deliverability_domains copy.
//
// Vicky 2026-08-28: the upload cron and the watchdog both reported 439
// Premium-Tenant domains "in NO Bison instance". Bison had every one of them
// (75/75 sampled, inboxes attached) — Ramon's upload had worked. Our copy is
// refreshed by a crawl that runs every ~2 days per instance and pages through
// tens of thousands of inboxes, so anything uploaded since the last pass is
// invisible to it. Acting on that stale answer would have re-uploaded 439
// domains that were already there and created duplicate senders.
//
// Rule: for "did an external system receive this?", ask the external system.
// Our table stays the source for metrics and history, never for existence.
import { bisonFetch, senderSearchTerm, emailIsOnDomain } from "@/lib/bison";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

/** Sender count for a domain in one instance. -1 = the check itself failed
 *  (network/auth/rate limit) — callers must treat that as "unknown", never as
 *  absent, or a bad minute turns into a wrong action. */
export async function senderCountInBison(
  instance: BisonInstanceSlug,
  domain: string,
): Promise<number> {
  // Label-only term + exact-domain counting: meta.total is NOT the domain's
  // count any more (it includes name-cousins, and on the newer FR/OC Bison a
  // dotted query with no hits fuzzy-matched thousands of foreign senders —
  // which would have made every un-uploaded order look "present").
  try {
    let count = 0;
    for (let page = 1; page <= 8; page++) {
      const res = await bisonFetch(instance, `/sender-emails?search=${encodeURIComponent(senderSearchTerm(domain))}&page=${page}&per_page=15`);
      if (!res.ok) return -1;
      const json = (await res.json().catch(() => null)) as
        | { data?: { email?: string }[]; meta?: { last_page?: number } }
        | null;
      if (!json) return -1;
      const data = Array.isArray(json.data) ? json.data : [];
      count += data.filter((s) => emailIsOnDomain(s.email, domain)).length;
      const last = json.meta?.last_page || 1;
      if (page >= last || data.length === 0) break;
    }
    return count;
  } catch {
    return -1;
  }
}

export type Presence = "present" | "absent" | "unknown";

export async function isDomainInBison(
  instance: BisonInstanceSlug,
  domain: string,
): Promise<Presence> {
  const n = await senderCountInBison(instance, domain);
  return n < 0 ? "unknown" : n > 0 ? "present" : "absent";
}

/** Bounded-concurrency presence check for many (instance, domain) pairs. */
export async function checkPresence(
  pairs: { instance: BisonInstanceSlug; domain: string }[],
  opts: { concurrency?: number; deadlineMs?: number } = {},
): Promise<Map<string, Presence>> {
  const out = new Map<string, Presence>();
  const concurrency = opts.concurrency ?? 6;
  const deadline = Date.now() + (opts.deadlineMs ?? 120_000);
  for (let i = 0; i < pairs.length; i += concurrency) {
    if (Date.now() > deadline) break; // unchecked pairs stay absent from the map = unknown
    const batch = pairs.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((p) => isDomainInBison(p.instance, p.domain)));
    batch.forEach((p, j) => out.set(`${p.instance}:${p.domain}`, results[j]));
  }
  return out;
}
