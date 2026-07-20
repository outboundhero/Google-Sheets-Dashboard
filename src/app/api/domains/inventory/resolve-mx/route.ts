import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { getSupabaseAdmin } from "@/lib/supabase";
import { resolveMxProvider } from "@/lib/mx-resolver";

// POST /api/domains/inventory/resolve-mx  (admin-only via middleware)
// Resolves + caches the MX provider for domain_inventory rows not yet checked.
// Body: { limit?: number }. Returns { processed, resolved, remaining } so the
// client can loop until remaining === 0.
//
// GET is a no-write DIAGNOSTIC: resolves a few sample domains + does one test
// write, returning the raw results + any write error. Open it in the browser
// (admin) to see whether DoH / the DB write works on the server.
export const maxDuration = 60;

const CONCURRENT = 50;
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
    const limit = Number.isFinite(body?.limit) ? Math.max(1, Math.min(1000, Math.floor(body.limit))) : 300;

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
    let failed = 0;
    const nowIso = new Date().toISOString();
    const sample: { domain: string; provider: string | null; error: string | null }[] = [];

    for (let i = 0; i < domains.length; i += CONCURRENT) {
      const batch = domains.slice(i, i + CONCURRENT);
      const settled = await Promise.allSettled(batch.map((d) => resolveMxProvider(d)));
      const definite = settled
        .map((s) => (s.status === "fulfilled" ? s.value : null))
        .filter((r): r is NonNullable<typeof r> => r !== null);
      for (const r of definite) {
        if (sample.length < 5) sample.push({ domain: r.domain, provider: r.provider, error: r.error });
        if (r.provider === null) failed++;
      }
      // Batch the writes: one upsert per wave instead of 500 sequential updates.
      const updates = definite
        .filter((r) => r.provider !== null)
        .map((r) => ({ domain: r.domain, mx_provider: r.provider, mx_hosts: r.hosts, mx_checked_at: nowIso }));
      if (updates.length > 0) {
        const { error: upErr } = await supabase
          .from("domain_inventory")
          .upsert(updates, { onConflict: "domain" });
        if (!upErr) resolved += updates.length;
        else if (sample.length < 6) sample.push({ domain: "(upsert error)", provider: null, error: upErr.message });
      }
    }

    const { count: remaining } = await supabase
      .from("domain_inventory")
      .select("domain", { count: "exact", head: true })
      .is("mx_checked_at", null);

    const redis = getRedis();
    if (redis && resolved > 0) await redis.del(CACHE_KEY);

    return NextResponse.json({ processed: domains.length, resolved, failed, remaining: remaining ?? 0, sample });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Diagnostic — no writes except one test update. Open in the browser (admin).
export async function GET() {
  try {
    const samples = ["acebuildingclean.com", "24commercialcleaning.info", "google.com", "accessjanitorial.info"];
    const results = await Promise.all(samples.map((d) => resolveMxProvider(d)));

    const supabase = getSupabaseAdmin();
    let writeError: string | null = null;
    let wroteDomain: string | null = null;
    const first = results.find((r) => r.provider !== null);
    if (first) {
      const { error } = await supabase
        .from("domain_inventory")
        .update({ mx_provider: first.provider, mx_hosts: first.hosts, mx_checked_at: new Date().toISOString() })
        .eq("domain", first.domain);
      writeError = error ? error.message : null;
      wroteDomain = first.domain;
    }

    return NextResponse.json({ dohWorks: results.some((r) => r.provider !== null), results, wroteDomain, writeError });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
