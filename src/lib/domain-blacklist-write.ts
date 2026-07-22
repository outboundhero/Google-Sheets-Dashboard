import { Redis } from "@upstash/redis";
import type { SupabaseClient } from "@supabase/supabase-js";

// Shared DB write for the Domains-page SURBL / Spamhaus bulk checks. A domain
// may live in domain_inventory and/or porkbun_domains — we write the result to
// whichever table(s) actually have a row for it (never insert, so we don't trip
// the NOT NULL `source` column on domain_inventory's insert path).

const CACHE_KEY = "domain-inventory:v1";

function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

/** Which of the two tables each domain has a row in. */
export async function findBlacklistTargets(
  supabase: SupabaseClient,
  domains: string[],
): Promise<{ inv: Set<string>; pork: Set<string> }> {
  const inv = new Set<string>();
  const pork = new Set<string>();
  for (let i = 0; i < domains.length; i += 200) {
    const slice = domains.slice(i, i + 200);
    const [a, b] = await Promise.all([
      supabase.from("domain_inventory").select("domain").in("domain", slice),
      supabase.from("porkbun_domains").select("domain").in("domain", slice),
    ]);
    for (const r of a.data || []) inv.add(r.domain as string);
    for (const r of b.data || []) pork.add(r.domain as string);
  }
  return { inv, pork };
}

/**
 * Write definite listing results (Map<domain, listed:boolean>) to both tables.
 * Groups by listed=true/false so each table needs at most two batched UPDATEs.
 */
export async function writeBlacklistResults(
  supabase: SupabaseClient,
  kind: "surbl" | "spamhaus",
  definite: Map<string, boolean>,
  targets: { inv: Set<string>; pork: Set<string> },
): Promise<void> {
  if (definite.size === 0) return;
  const listedCol = kind === "surbl" ? "surbl_listed" : "spamhaus_listed";
  const atCol = kind === "surbl" ? "surbl_checked_at" : "spamhaus_checked_at";
  const now = new Date().toISOString();

  const listedTrue: string[] = [];
  const listedFalse: string[] = [];
  for (const [domain, listed] of definite) (listed ? listedTrue : listedFalse).push(domain);

  const updateBatch = async (table: string, domains: string[], value: boolean) => {
    for (let i = 0; i < domains.length; i += 200) {
      const slice = domains.slice(i, i + 200);
      if (slice.length === 0) continue;
      const { error } = await supabase
        .from(table)
        .update({ [listedCol]: value, [atCol]: now })
        .in("domain", slice);
      if (error) console.error(`[${kind}-check] ${table} update failed:`, error.message);
    }
  };

  await updateBatch("domain_inventory", listedTrue.filter((d) => targets.inv.has(d)), true);
  await updateBatch("domain_inventory", listedFalse.filter((d) => targets.inv.has(d)), false);
  await updateBatch("porkbun_domains", listedTrue.filter((d) => targets.pork.has(d)), true);
  await updateBatch("porkbun_domains", listedFalse.filter((d) => targets.pork.has(d)), false);

  // Inventory list is cached in Redis — bust it so the SURBL/Spamhaus columns refresh.
  if (targets.inv.size > 0) {
    const redis = getRedis();
    if (redis) await redis.del(CACHE_KEY);
  }
}
