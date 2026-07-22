import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { getSupabaseAdmin } from "@/lib/supabase";

// POST /api/domains/inventory/hide  (admin-only via middleware)
// Body: { domains: string[], hidden: boolean } → mark domains hidden/non-hidden
// in the All Domains inventory. Returns per-domain results for the panel.
export const maxDuration = 30;

const CACHE_KEY = "domain-inventory:v1";

function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { domains?: string[]; hidden?: boolean };
    const domains = Array.from(
      new Set((body.domains || []).filter((d): d is string => typeof d === "string").map((d) => d.trim().toLowerCase()).filter(Boolean)),
    );
    const hidden = body.hidden === true;
    if (domains.length === 0) return NextResponse.json({ error: "domains required" }, { status: 400 });

    const supabase = getSupabaseAdmin();
    let updated = 0;
    const results: { domain: string; status: "ok" | "failed"; error?: string }[] = [];
    for (let i = 0; i < domains.length; i += 200) {
      const slice = domains.slice(i, i + 200);
      const { error, count } = await supabase
        .from("domain_inventory")
        .update({ hidden }, { count: "exact" })
        .in("domain", slice);
      if (error) {
        for (const d of slice) results.push({ domain: d, status: "failed", error: error.message });
      } else {
        updated += count ?? 0;
        for (const d of slice) results.push({ domain: d, status: "ok" });
      }
    }

    const redis = getRedis();
    if (redis && updated > 0) await redis.del(CACHE_KEY);

    return NextResponse.json({
      hidden,
      ok: results.filter((r) => r.status === "ok").length,
      failed: results.filter((r) => r.status === "failed").length,
      updated,
      results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
