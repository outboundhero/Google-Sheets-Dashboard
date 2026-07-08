// Per-client queue of secondary domains awaiting a whitelist email.
// Table: whitelist_queue (client_tag, domain) PK, status 'queued' | 'sent'.
// The PK is the dedup: a domain already queued/sent for a client is never
// duplicated or re-emailed (see enqueueDomains' ignoreDuplicates).
import { getSupabaseAdmin } from "@/lib/supabase";

const norm = (domains: string[]) =>
  [...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))];

/**
 * Add domains to a client's queue. Already-queued or already-sent domains are
 * left untouched (ignoreDuplicates) so nothing gets emailed twice.
 * Returns how many rows were newly queued vs skipped (already present).
 */
export async function enqueueDomains(
  clientTag: string,
  domains: string[],
): Promise<{ queued: number; skipped: number }> {
  const list = norm(domains);
  if (list.length === 0) return { queued: 0, skipped: 0 };

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("whitelist_queue")
    .upsert(
      list.map((domain) => ({ client_tag: clientTag, domain, status: "queued" })),
      { onConflict: "client_tag,domain", ignoreDuplicates: true },
    )
    .select("domain");
  if (error) throw new Error(error.message);

  const queued = data?.length ?? 0;
  return { queued, skipped: list.length - queued };
}

/** All 'queued' rows grouped by client_tag. */
export async function getQueuedByClient(): Promise<Record<string, string[]>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("whitelist_queue")
    .select("client_tag, domain")
    .eq("status", "queued");
  if (error) throw new Error(error.message);

  const grouped: Record<string, string[]> = {};
  for (const row of data || []) {
    (grouped[row.client_tag] ||= []).push(row.domain);
  }
  return grouped;
}

/** Of `domains`, return those NOT already sent to this client (send-now dedup). */
export async function filterUnsent(clientTag: string, domains: string[]): Promise<string[]> {
  const list = norm(domains);
  if (list.length === 0) return [];

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("whitelist_queue")
    .select("domain")
    .eq("client_tag", clientTag)
    .eq("status", "sent")
    .in("domain", list);
  if (error) throw new Error(error.message);

  const alreadySent = new Set((data || []).map((r) => r.domain));
  return list.filter((d) => !alreadySent.has(d));
}

/** Mark domains as sent for a client (used by send-now and the cron). */
export async function markSent(clientTag: string, domains: string[]): Promise<void> {
  const list = norm(domains);
  if (list.length === 0) return;

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("whitelist_queue")
    .upsert(
      list.map((domain) => ({ client_tag: clientTag, domain, status: "sent", sent_at: now })),
      { onConflict: "client_tag,domain" },
    );
  if (error) throw new Error(error.message);
}

export interface ClientPartition {
  /** sub-tag → the domains that carry that sub-tag in Bison */
  buckets: Map<string, string[]>;
  /** queued domains currently tagged Burnt — pointless to whitelist */
  burnt: string[];
  /** compound-tag domains matching NO sub-tag — left queued, surfaced */
  unmatched: string[];
}

/**
 * Partition a client's queued domains into per-recipient buckets.
 *
 * Compound client tags ("DBSM / DBSA / DBSNJ / DBSF") come from tracked
 * sheets that serve several ReplyRouter clients at once — ReplyRouter has no
 * client under the literal compound name (404s), which used to strand these
 * queues forever. Each domain DOES carry its own sub-client tag in Bison
 * (deliverability_domains.tags), so we split by that: one bucket per
 * sub-tag, each emailed separately with only its own domains.
 *
 * Single (non-compound) tags come back as one bucket, unchanged behavior —
 * except Burnt-tagged domains, which are excluded everywhere (asking a
 * client to whitelist a domain being retired is noise).
 */
export async function partitionByClientSubTags(
  clientTag: string,
  domains: string[],
): Promise<ClientPartition> {
  const list = norm(domains);
  const subTags = clientTag.split("/").map((s) => s.trim()).filter(Boolean);

  // Domain → lowercase tag set from deliverability_domains (any instance).
  const supabase = getSupabaseAdmin();
  const tagsByDomain = new Map<string, Set<string>>();
  for (let i = 0; i < list.length; i += 100) {
    const { data, error } = await supabase
      .from("deliverability_domains")
      .select("domain, tags")
      .in("domain", list.slice(i, i + 100));
    if (error) throw new Error(error.message);
    for (const r of (data || []) as { domain: string; tags: string[] | null }[]) {
      const k = r.domain.toLowerCase();
      const set = tagsByDomain.get(k) ?? new Set<string>();
      for (const t of r.tags || []) set.add((t || "").trim().toLowerCase());
      tagsByDomain.set(k, set);
    }
  }

  const burnt = list.filter((d) => tagsByDomain.get(d)?.has("burnt"));
  const live = list.filter((d) => !tagsByDomain.get(d)?.has("burnt"));

  const buckets = new Map<string, string[]>();
  const unmatched: string[] = [];
  if (subTags.length <= 1) {
    if (live.length > 0) buckets.set(subTags[0] ?? clientTag, live);
    return { buckets, burnt, unmatched };
  }
  for (const d of live) {
    const tags = tagsByDomain.get(d);
    const matches = subTags.filter((s) => tags?.has(s.toLowerCase()));
    if (matches.length === 0) {
      unmatched.push(d);
      continue;
    }
    // A domain tagged for several sub-clients goes in each of their emails.
    for (const m of matches) (buckets.get(m) ?? buckets.set(m, []).get(m)!).push(d);
  }
  return { buckets, burnt, unmatched };
}
