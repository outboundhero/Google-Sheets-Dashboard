import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { getSupabaseAdmin } from "@/lib/supabase";
import { porkbunAccounts, listAllDomains, type PorkbunDomainRow } from "@/lib/porkbun-domains";
import { normalizeDomain } from "@/lib/domain-inventory";

// POST /api/domains/inventory/sync  (admin-only via middleware)
// Pulls every domain from both Porkbun accounts and upserts them into
// domain_inventory (source = porkbun_<accountKey>), pruning stale Porkbun rows
// per successfully-synced source (never touching manual rows).
export const maxDuration = 120;

const LOCK_KEY = "domain-inventory:sync:lock";
const CACHE_KEY = "domain-inventory:v1";

function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function parseExpire(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = new Date(raw.replace(" ", "T")).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export async function POST() {
  const redis = getRedis();
  const runId = crypto.randomUUID();
  let haveLock = false;
  if (redis) {
    const got = await redis.set(LOCK_KEY, runId, { nx: true, ex: 300 });
    if (!got) return NextResponse.json({ error: "A sync is already running" }, { status: 409 });
    haveLock = true;
  }

  try {
    const supabase = getSupabaseAdmin();
    const accts = porkbunAccounts();
    const results = await Promise.allSettled(accts.map((a) => listAllDomains(a)));

    const accountInfo: { account: string; ok: boolean; count?: number; error?: string }[] = [];
    let upserted = 0;
    let pruned = 0;

    for (let i = 0; i < accts.length; i++) {
      const acct = accts[i];
      const source = `porkbun_${acct.key}`;
      const res = results[i];
      if (res.status !== "fulfilled") {
        accountInfo.push({ account: acct.label, ok: false, error: res.reason instanceof Error ? res.reason.message : "failed" });
        continue;
      }
      const rows: PorkbunDomainRow[] = res.value;
      const nowIso = new Date().toISOString();
      const freshSet = new Set<string>();

      const upsertRows = rows
        .map((r) => {
          const domain = normalizeDomain(r.domain);
          if (!domain) return null;
          freshSet.add(domain);
          return {
            domain,
            source,
            manual: false,
            tld: (r.tld || domain.split(".").pop() || "").toLowerCase(),
            porkbun_status: r.status || null,
            expire_date: parseExpire(r.expireDate),
            auto_renew: r.autoRenew === 1,
            last_synced_at: nowIso,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      for (let j = 0; j < upsertRows.length; j += 500) {
        const { error } = await supabase
          .from("domain_inventory")
          .upsert(upsertRows.slice(j, j + 500), { onConflict: "domain" });
        if (error) throw new Error(`upsert (${acct.label}): ${error.message}`);
      }
      upserted += upsertRows.length;

      // Prune: domains previously under this source that Porkbun no longer
      // returns (and that aren't manual). Fetch existing → diff → delete.
      const existing: string[] = [];
      let from = 0;
      for (let guard = 0; guard < 100; guard++) {
        const { data } = await supabase
          .from("domain_inventory")
          .select("domain")
          .eq("source", source)
          .eq("manual", false)
          .range(from, from + 999);
        const batch = (data || []).map((d) => d.domain as string);
        existing.push(...batch);
        if (batch.length < 1000) break;
        from += 1000;
      }
      const stale = existing.filter((d) => !freshSet.has(d));
      for (let j = 0; j < stale.length; j += 200) {
        const { error } = await supabase
          .from("domain_inventory")
          .delete()
          .eq("source", source)
          .eq("manual", false)
          .in("domain", stale.slice(j, j + 200));
        if (!error) pruned += Math.min(200, stale.length - j);
      }

      accountInfo.push({ account: acct.label, ok: true, count: upsertRows.length });
    }

    if (redis) await redis.del(CACHE_KEY);
    return NextResponse.json({ accounts: accountInfo, upserted, pruned });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    if (haveLock && redis) {
      const cur = await redis.get(LOCK_KEY);
      if (cur === runId) await redis.del(LOCK_KEY);
    }
  }
}
