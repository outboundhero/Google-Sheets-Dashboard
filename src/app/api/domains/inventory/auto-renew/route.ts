import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { getSupabaseAdmin } from "@/lib/supabase";
import { porkbunAccounts, updateAutoRenew } from "@/lib/porkbun-domains";

// POST /api/domains/inventory/auto-renew  (admin-only via middleware)
// Body: { domains: string[], enabled: boolean }
// Toggles Porkbun auto-renew for each OWNED domain on ITS Porkbun account
// (resolved from domain_inventory.source), low concurrency + retry, and mirrors
// the result onto domain_inventory.auto_renew. The FE drives it in batches
// through a persistent progress panel. Returns per-domain outcomes.
export const maxDuration = 120;

const CONCURRENCY = 3;
const CACHE_KEY = "domain-inventory:v1";

function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { domains?: string[]; enabled?: boolean };
    const domains = Array.from(
      new Set((body.domains || []).filter((d): d is string => typeof d === "string").map((d) => d.trim().toLowerCase()).filter(Boolean)),
    );
    const enabled = body.enabled === true;
    if (domains.length === 0) return NextResponse.json({ error: "domains required" }, { status: 400 });

    const supabase = getSupabaseAdmin();

    // Which Porkbun account each domain lives in.
    const sourceByDomain = new Map<string, string>();
    for (let i = 0; i < domains.length; i += 300) {
      const { data } = await supabase
        .from("domain_inventory")
        .select("domain, source")
        .in("domain", domains.slice(i, i + 300));
      for (const r of data || []) sourceByDomain.set((r.domain as string).toLowerCase(), r.source as string);
    }

    const accts = porkbunAccounts();
    const byKey = new Map(accts.map((a) => [a.key, a]));

    const results: { domain: string; status: "ok" | "failed"; error?: string }[] = [];
    const succeeded: string[] = [];
    for (let i = 0; i < domains.length; i += CONCURRENCY) {
      const batch = domains.slice(i, i + CONCURRENCY);
      const settled = await Promise.all(
        batch.map(async (domain) => {
          const source = sourceByDomain.get(domain);
          if (!source) return { domain, status: "failed" as const, error: "not in All Domains inventory — Refresh Porkbun" };
          if (source === "manual") return { domain, status: "failed" as const, error: "manual domain — no Porkbun account" };
          const acct = byKey.get(source.replace(/^porkbun_/, ""));
          if (!acct) return { domain, status: "failed" as const, error: `no Porkbun account for "${source}"` };
          try {
            await updateAutoRenew(acct, domain, enabled);
            succeeded.push(domain);
            return { domain, status: "ok" as const };
          } catch (e) {
            return { domain, status: "failed" as const, error: e instanceof Error ? e.message : "failed" };
          }
        }),
      );
      results.push(...settled);
    }

    // Mirror onto the inventory so the UI reflects the new state immediately.
    for (let i = 0; i < succeeded.length; i += 200) {
      await supabase.from("domain_inventory").update({ auto_renew: enabled }).in("domain", succeeded.slice(i, i + 200));
    }
    if (succeeded.length > 0) {
      const redis = getRedis();
      if (redis) await redis.del(CACHE_KEY);
    }

    return NextResponse.json({
      enabled,
      ok: results.filter((r) => r.status === "ok").length,
      failed: results.filter((r) => r.status === "failed").length,
      results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
