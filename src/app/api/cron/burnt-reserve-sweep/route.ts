import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getKnownClientTags } from "@/lib/replacement/cross-tag-audit";
import { getHandledDomains, scheduleCancellations, logEvents } from "@/lib/replacement/store";
import { getSkipSet, skipKey } from "@/lib/replacement/skips";
import { getFrozenMetrics } from "@/lib/replacement/metric-freeze";
import { getThresholdConfig } from "@/lib/replacement/threshold-groups-store";
import { evaluateSegments, type DomainMetrics } from "@/lib/replacement/threshold-groups";
import { hasBurntTag } from "@/lib/replacement/burnt-tag";
import { ALL_INSTANCE_SLUGS, type BisonInstanceSlug } from "@/lib/bison-instances";
import { pstDateString } from "@/lib/date-utils";

export const maxDuration = 300;

// GET /api/cron/burnt-reserve-sweep — the missing half of Spencer's doc point
// #2 (2026-08-26): "anything marked burnt or placed into the deletion queue
// should immediately stop appearing as usable reserve inventory… it should be
// queued for deletion from the vendor and also deleted altogether from the
// instance."
//
// The first half was already true: burnt/queued domains are excluded from
// every reserve pool. The second half was NOT — the only thing that ever
// created a vendor-cancellation row was execute-runner, i.e. burnt domains
// caught inside a CLIENT-TAGGED replacement run. A domain that went burnt
// while sitting untagged (client churned, hand-tagged Burnt, flagged while in
// reserve) was hidden from reserve and then sat in the instance forever,
// costing vendor money, until a human noticed it on the burnt-review card.
//
// This sweep is that missing entry point. It creates NO new deletion
// machinery: it hands candidates to the same scheduleCancellations() the
// executor uses, so they flow through cancel-bridge → staged vendor cancel →
// Bison sender delete → "verified 0 remaining", with stale-hold protection and
// a replacement_events trail behind every step.
//
// ?dry=1   preview only — computes everything, writes nothing.
// ?limit=  override the per-run cap (default SWEEP_CAP).

/** Max domains queued per run. A bad metrics read can then cost us at most
 *  this many paid domains before someone sees it on the audit feed — the same
 *  reasoning as the deliverability prune's 40% bail. */
const SWEEP_CAP = 25;

/** Below this, a domain has no meaningful history and can never be swept.
 *  ISS, 2026-08-13: domains under a month old have null trailing windows, so
 *  "burnt" is unprovable — never delete on an absence of data. */
const MIN_SENT_TO_JUDGE = 200;

interface DomRow {
  instance: BisonInstanceSlug;
  domain: string;
  tags: string[] | null;
  total_sent: number | null;
  blacklisted: boolean | null;
  spamhaus_dbl: boolean | null;
  outlook_count: number | null;
  google_count: number | null;
}
interface RateRow {
  instance: string; domain: string;
  reply_10: number | null; reply_15: number | null; reply_30: number | null;
  bounce_10: number | null; bounce_15: number | null; bounce_30: number | null;
}

interface SweepRow {
  instance: BisonInstanceSlug;
  domain: string;
  provider: string | null;
  sent: number;
  /** "hand-tagged Burnt" or the group that fired on the frozen snapshot. */
  verdict: string;
  reasons: string[];
  /** Whether today's live numbers still agree with the frozen verdict. */
  liveAgrees: boolean;
}

const providerOf = (d: DomRow): string | null => {
  const o = d.outlook_count ?? 0, g = d.google_count ?? 0;
  if (o > 0 && g > 0) return "mixed";
  if (o > 0) return "outlook";
  if (g > 0) return "google";
  return null;
};

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const dryRun = url.searchParams.get("dry") === "1";
    const cap = Math.max(0, Number(url.searchParams.get("limit") ?? SWEEP_CAP) || SWEEP_CAP);

    const supabase = getSupabaseAdmin();
    const groupConfig = await getThresholdConfig();
    const [knownTags, handled, skipSet, frozenMetrics] = await Promise.all([
      getKnownClientTags(), getHandledDomains(), getSkipSet(), getFrozenMetrics(),
    ]);

    const knownUpper = new Set([...knownTags].map((t) => t.toUpperCase()));

    // Every domain, paginated.
    const rows: DomRow[] = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase
        .from("deliverability_domains")
        .select("instance,domain,tags,total_sent,blacklisted,spamhaus_dbl,outlook_count,google_count")
        .in("instance", ALL_INSTANCE_SLUGS)
        .range(off, off + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      rows.push(...(data as DomRow[]));
      if (data.length < 1000) break;
    }

    // Live trailing windows — used ONLY as a second opinion, never as the
    // verdict on its own (see the confirm step below).
    const liveRates = new Map<string, RateRow>();
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase
        .rpc("trailing_domain_rates", { p_instances: ALL_INSTANCE_SLUGS, p_today: pstDateString(new Date()) })
        .range(off, off + 999);
      if (error) throw new Error(`trailing rates: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const r of data as RateRow[]) liveRates.set(`${r.instance}:${r.domain}`, r);
      if ((data as RateRow[]).length < 1000) break;
    }

    const isClientTagged = (d: DomRow) =>
      (d.tags || []).some((t) => knownUpper.has(String(t).trim().toUpperCase()));

    const candidates: SweepRow[] = [];
    const disagreements: SweepRow[] = [];
    let scanned = 0;

    for (const d of rows) {
      const key = `${d.instance}:${d.domain}`;

      // --- Guards. Each one is a reason NOT to touch a paid domain. ---
      if (isClientTagged(d)) continue;              // assigned — the executor owns it
      if (handled.has(key)) continue;               // already queued/removed — no double-queue
      if (skipSet.has(skipKey(d.instance, d.domain))) continue; // a human said keep
      scanned++;

      const tagsUpper = new Set((d.tags || []).map((t) => String(t).trim().toUpperCase()));
      const sent = d.total_sent ?? 0;

      // A hand-applied Burnt tag is a human verdict and needs no metrics.
      if (hasBurntTag(d.tags)) {
        candidates.push({
          instance: d.instance, domain: d.domain, provider: providerOf(d), sent,
          verdict: "hand-tagged Burnt", reasons: ["someone tagged this Burnt in Bison"],
          liveAgrees: true,
        });
        continue;
      }

      // Never judge a domain that has no history to judge.
      if (sent < MIN_SENT_TO_JUDGE) continue;

      // The metrics verdict runs on the FROZEN snapshot — the numbers the
      // domain earned while it was still sending. Judging a parked domain on
      // today's trailing windows would flag it for sending nothing, which is
      // precisely what the freeze exists to prevent (Spencer, 25:24).
      const frozen = frozenMetrics.get(key);
      if (!frozen) continue;                        // no snapshot yet → not judged this run
      const frozenVerdict = evaluateSegments(frozen, tagsUpper, groupConfig);
      if (!frozenVerdict.burnt) continue;

      // Second gate: recheck against TODAY's live numbers. This can only ever
      // spare a domain, never condemn one — a domain whose live data no longer
      // supports the old verdict goes to humans instead of to the vendor.
      const lr = liveRates.get(key);
      const live: DomainMetrics = {
        sent,
        reply_10: lr?.reply_10 ?? null, reply_15: lr?.reply_15 ?? null, reply_30: lr?.reply_30 ?? null,
        bounce_10: lr?.bounce_10 ?? null, bounce_15: lr?.bounce_15 ?? null, bounce_30: lr?.bounce_30 ?? null,
        surbl: d.blacklisted, spamhaus: d.spamhaus_dbl,
      };
      const liveVerdict = evaluateSegments(live, tagsUpper, groupConfig);

      const row: SweepRow = {
        instance: d.instance, domain: d.domain, provider: providerOf(d), sent,
        verdict: frozenVerdict.groupName ?? "burnt",
        reasons: frozenVerdict.reasons,
        liveAgrees: liveVerdict.burnt,
      };
      if (liveVerdict.burnt) candidates.push(row);
      else disagreements.push(row);                 // frozen says burnt, live doesn't — human call
    }

    // Deterministic order (worst history first) so repeated runs chew through
    // the same list from the top rather than sampling randomly.
    candidates.sort((a, b) => b.sent - a.sent || a.domain.localeCompare(b.domain));
    const toQueue = candidates.slice(0, cap);

    if (!dryRun && toQueue.length > 0) {
      await scheduleCancellations(
        toQueue.map((c) => ({
          instance: c.instance,
          domain: c.domain,
          clientTag: null,
          provider: c.provider,
          reason: `burnt in reserve — sweep (${c.verdict})`,
        })),
      );
      await logEvents(
        toQueue.map((c) => ({
          instance: c.instance,
          domain: c.domain,
          clientTag: null,
          eventType: "cancel_queued",
          detail: `burnt-reserve sweep: unassigned + burnt (${c.verdict}) — ${c.reasons.join(", ") || "no reasons recorded"}; live numbers agree. Queued for staged vendor cancel + Bison delete.`,
          signals: { sent: c.sent, provider: c.provider, verdict: c.verdict, reasons: c.reasons },
        })),
      );
    }

    return NextResponse.json({
      dryRun,
      detectorEnabled: groupConfig.enabled,
      scanned,
      burntUnassigned: candidates.length,
      queued: dryRun ? 0 : toQueue.length,
      cap,
      remaining: Math.max(0, candidates.length - toQueue.length),
      /** Frozen verdict said burnt, today's live numbers disagree — NOT queued. */
      needsHuman: disagreements.length,
      needsHumanSample: disagreements.slice(0, 20),
      wouldQueue: toQueue,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "burnt-reserve sweep failed" },
      { status: 500 },
    );
  }
}
