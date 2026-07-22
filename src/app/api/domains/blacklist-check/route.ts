import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { checkBlacklist, type BlacklistResult } from "@/lib/blacklist-resolver";
import { findBlacklistTargets, writeBlacklistResults } from "@/lib/domain-blacklist-write";

// POST /api/domains/blacklist-check  (admin-only via middleware)
// Body: { domains: string[] } → SURBL check for any domain (inventory / purchased
// / buy). Writes definite results to domain_inventory and/or porkbun_domains.
// Returns per-domain { status: "ok"|"failed" } for the bulk-op panel (inconclusive
// = "failed" so Retry re-runs it).
export const maxDuration = 60;
const CONCURRENT = 100;

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const raw = Array.isArray(body?.domains) ? body.domains : [];
    const domains = Array.from(new Set<string>(
      raw.filter((d: unknown): d is string => typeof d === "string").map((d: string) => d.trim().toLowerCase()).filter(Boolean),
    ));
    if (domains.length === 0) return NextResponse.json({ error: "domains array required" }, { status: 400 });

    const supabase = getSupabaseAdmin();
    const targets = await findBlacklistTargets(supabase, domains);

    const byDomain = new Map<string, BlacklistResult>();
    for (let i = 0; i < domains.length; i += CONCURRENT) {
      const batch = domains.slice(i, i + CONCURRENT);
      const settled = await Promise.allSettled(batch.map((d) => checkBlacklist(d)));
      batch.forEach((d, j) => {
        const r = settled[j];
        byDomain.set(d, r.status === "fulfilled" ? r.value : { domain: d, blacklisted: null, lists: [], error: "unknown" });
      });
    }

    const definite = new Map<string, boolean>();
    for (const [d, r] of byDomain) if (r.blacklisted !== null) definite.set(d, r.blacklisted);
    await writeBlacklistResults(supabase, "surbl", definite, targets);

    const results = domains.map((d) => {
      const r = byDomain.get(d);
      return r && r.blacklisted !== null
        ? { domain: d, status: "ok" as const, listed: r.blacklisted }
        : { domain: d, status: "failed" as const, error: r?.error || "inconclusive (rate-limited / DNS)" };
    });
    return NextResponse.json({
      results,
      ok: results.filter((r) => r.status === "ok").length,
      failed: results.filter((r) => r.status === "failed").length,
      updated: definite.size,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
