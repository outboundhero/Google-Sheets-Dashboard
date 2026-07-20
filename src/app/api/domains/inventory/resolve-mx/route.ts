import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { getSupabaseAdmin } from "@/lib/supabase";
import { resolveMxProvider } from "@/lib/mx-resolver";

// POST /api/domains/inventory/resolve-mx  (admin-only via middleware)
// Resolves + caches the MX provider for domain_inventory rows not yet checked.
// Body: { limit?: number }. Returns { processed, resolved, remaining } so the
// client can loop until remaining === 0.
export const maxDuration = 60;

const CONCURRENT = 100;
const CACHE_KEY = "domain-inventory:v1";

function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const limit = Number.isFinite(body?.limit) ? Math.max(1, Math.min(1000, Math.floor(body.limit))) : 500;

    const supabase = getSupabaseAdmin();
    const { data: rows, error } = await supabase
      .from("domain_inventory")
      .select("domain")
      .is("mx_checked_at", null)
      .order("first_seen_at", { ascending: true })
      .limit(limit);
    if (error) throw new Error(error.message);
    const domains = (rows || []).map((r) => r.domain as string);

    let resolved = 0;
    const nowIso = new Date().toISOString();
    for (let i = 0; i < domains.length; i += CONCURRENT) {
      const batch = domains.slice(i, i + CONCURRENT);
      const settled = await Promise.allSettled(batch.map((d) => resolveMxProvider(d)));
      const updates = settled
        .map((s) => (s.status === "fulfilled" ? s.value : null))
        .filter((r): r is NonNullable<typeof r> => r !== null && r.provider !== null)
        .map((r) => ({
          domain: r.domain,
          mx_provider: r.provider,
          mx_hosts: r.hosts,
          mx_checked_at: nowIso,
        }));
      // Upsert requires the row to exist (it does — we selected it). Update each.
      for (const u of updates) {
        const { error: upErr } = await supabase
          .from("domain_inventory")
          .update({ mx_provider: u.mx_provider, mx_hosts: u.mx_hosts, mx_checked_at: u.mx_checked_at })
          .eq("domain", u.domain);
        if (!upErr) resolved++;
      }
    }

    const { count: remaining } = await supabase
      .from("domain_inventory")
      .select("domain", { count: "exact", head: true })
      .is("mx_checked_at", null);

    const redis = getRedis();
    if (redis && resolved > 0) await redis.del(CACHE_KEY);

    return NextResponse.json({ processed: domains.length, resolved, remaining: remaining ?? 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
