import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { freezeMetrics, unfreeze } from "@/lib/replacement/metric-freeze";
import { getKnownClientTags } from "@/lib/replacement/cross-tag-audit";
import { getHandledDomains } from "@/lib/replacement/store";
import { hasBurntTag } from "@/lib/replacement/burnt-tag";
import { ALL_INSTANCE_SLUGS } from "@/lib/bison-instances";
import { pstDateString } from "@/lib/date-utils";
import type { DomainMetrics } from "@/lib/replacement/threshold-groups";

export const maxDuration = 300;

// GET /api/cron/metric-freeze — hourly sweep (Spencer 2026-08-26, "pause the
// trailing reply rates when a domain enters reserve"):
//
//   freeze  — any untagged domain without a snapshot gets one, taken from its
//             current trailing metrics. Running hourly means the snapshot is
//             at most an hour younger than the untag, i.e. still the numbers
//             it earned while sending — and EVERY untag path (trim, strip,
//             wrong-instance, offboarding, manual Remove Tags) is covered
//             without touching any of them.
//   unfreeze — a snapshot whose domain is client-tagged again is deleted;
//             the domain is sending, live windows apply.
//
// Never frozen: domains already leaving (removed/queued) and hand-tagged
// Burnt ones — those are deletion candidates, not reserve. First run
// backfills the whole current reserve. ?dry=1 previews.

export async function GET(request: Request) {
  try {
    const dryRun = new URL(request.url).searchParams.get("dry") === "1";
    const supabase = getSupabaseAdmin();
    const [knownTags, handled] = await Promise.all([getKnownClientTags(), getHandledDomains()]);

    interface Row { instance: string; domain: string; tags: string[] | null; total_sent: number | null; blacklisted: boolean | null; spamhaus_dbl: boolean | null }
    const rows: Row[] = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase
        .from("deliverability_domains")
        .select("instance, domain, tags, total_sent, blacklisted, spamhaus_dbl")
        .range(off, off + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      rows.push(...(data as Row[]));
      if (data.length < 1000) break;
    }
    const isTagged = (r: Row) => (r.tags || []).some((t) => knownTags.has(String(t).trim()));

    // Existing snapshots.
    const existing = new Set<string>();
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase.from("reserve_metric_freeze").select("instance, domain").range(off, off + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      for (const r of data) existing.add(`${r.instance}:${r.domain}`);
      if (data.length < 1000) break;
    }

    // Unfreeze: snapshot exists but the domain is client-tagged again.
    const taggedKeys = new Set(rows.filter(isTagged).map((r) => `${r.instance}:${r.domain}`));
    const toUnfreeze = [...existing].filter((k) => taggedKeys.has(k)).map((k) => {
      const i = k.indexOf(":");
      return { instance: k.slice(0, i), domain: k.slice(i + 1) };
    });

    // Freeze: untagged, not leaving, not Burnt-tagged, no snapshot yet.
    const candidates = rows.filter((r) =>
      !isTagged(r)
      && !existing.has(`${r.instance}:${r.domain}`)
      && !handled.has(`${r.instance}:${r.domain}`)
      && !hasBurntTag(r.tags),
    );

    let rates = new Map<string, { reply_10: number | null; reply_15: number | null; reply_30: number | null; bounce_10: number | null; bounce_15: number | null; bounce_30: number | null }>();
    if (candidates.length > 0) {
      const { data, error } = await supabase
        .rpc("trailing_domain_rates", { p_instances: ALL_INSTANCE_SLUGS, p_today: pstDateString(new Date()) })
        .range(0, 9999);
      if (error) throw new Error(`trailing rates: ${error.message}`);
      rates = new Map((data || []).map((r: { instance: string; domain: string } & Record<string, number | null>) => [`${r.instance}:${r.domain}`, r]));
    }

    const toFreeze = candidates.map((r) => {
      const rr = rates.get(`${r.instance}:${r.domain}`);
      const metrics: DomainMetrics = {
        sent: r.total_sent ?? 0,
        reply_10: rr?.reply_10 ?? null, reply_15: rr?.reply_15 ?? null, reply_30: rr?.reply_30 ?? null,
        bounce_10: rr?.bounce_10 ?? null, bounce_15: rr?.bounce_15 ?? null, bounce_30: rr?.bounce_30 ?? null,
        surbl: r.blacklisted, spamhaus: r.spamhaus_dbl,
      };
      return { instance: r.instance, domain: r.domain, metrics };
    });

    if (!dryRun) {
      await freezeMetrics(toFreeze);
      await unfreeze(toUnfreeze);
    }

    return NextResponse.json({
      dryRun,
      frozenNow: toFreeze.length,
      unfrozen: toUnfreeze.length,
      totalSnapshots: existing.size + (dryRun ? 0 : toFreeze.length - toUnfreeze.length),
      sample: toFreeze.slice(0, 5).map((f) => f.domain),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "metric-freeze failed" }, { status: 500 });
  }
}
