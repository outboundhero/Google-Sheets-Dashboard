import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getDuplicateDomains, scheduleDeletions, forceDeletionsNow, type DupInstance } from "@/lib/replacement/duplicate-domains";
import { getActiveCampaignKeys } from "@/lib/replacement/campaigns";
import { getKnownClientTags } from "@/lib/replacement/cross-tag-audit";
import { getAllocations } from "@/lib/client-tag-allocations";
import { logEvents } from "@/lib/replacement/store";
import { getInstance, isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";

export const maxDuration = 300;

// GET /api/cron/duplicate-cleanup — hourly: resolve domains that live in TWO
// Bison instances at once (move leftovers — the old move flow never deleted
// its source; new moves do, so this drains the backlog and then guards).
//
// The whole difficulty is picking the side to KEEP. Lifetime sent totals in
// deliverability_domains are mirrored by the move's metric carryover (JPCO's
// copies read identical on both sides), so the keeper is decided from
// per-side evidence that is NOT mirrored:
//
//   - per-inbox sends (deliverability_inboxes.emails_sent_count, crawled from
//     each Bison workspace separately)
//   - active campaigns for the domain's client tag in that instance
//   - the client tag's ALLOCATED group (allocation sheet)
//
// Decision, deliberately conservative — schedule a delete ONLY when:
//   A. tagged + allocated: keeper = the side in the allocated group; the
//      wrong-group side is deletable only if its tag has NO active campaign
//      there (nothing sends without a campaign). JPCO's 12 fit here.
//   B. untagged: exactly one side has inbox sends > 0 → keep it, delete the
//      silent side. Both silent → keep the move DESTINATION (the side that is
//      not first_instance in domain_first_created) and delete the origin —
//      that is the direction someone intended. Both active → a human call.
//   Anything else (3+ instances, conflicting signals, protected roots) is
//   reported in `needsHuman` and logged, never auto-deleted.
//
// Deletion itself goes through the existing verified machinery: pending row in
// duplicate_domain_deletions (grace, cancelable in the delete-queue view),
// fired by the fire-scheduled-deletions cron. This route deletes nothing
// directly.
//
// ?dry=1 preview · ?domain=x.com targeted · bounded per run.

const MAX_SCHEDULES_PER_RUN = 15;
const PROTECTED = new Set(["outboundhero.co", "facilityreach.com", "cleaningoutbound.com", "outboundclean.com"]);

interface Verdict {
  domain: string;
  keep: string;
  del: string;
  rule: string;
  clientTag?: string;
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const dryRun = params.get("dry") === "1";
    const onlyDomain = (params.get("domain") || "").trim().toLowerCase();
    // ?fire-pending=1 — one-off after the 2026-08-26 "immediate, not 3 days"
    // decision: drop the remaining grace on rows this cron already queued so
    // the 15-minute executor takes them on its next pass. Duplicate/move rows
    // only; manual-source rows keep their own flow.
    if (params.get("fire-pending") === "1") {
      const moved = await forceDeletionsNow();
      return NextResponse.json({ firedPending: moved });
    }

    const supabase = getSupabaseAdmin();
    const [dups, activeKeys, knownTags, { map: allocation }] = await Promise.all([
      getDuplicateDomains(),
      getActiveCampaignKeys(),
      getKnownClientTags(),
      getAllocations(),
    ]);

    let candidates = dups.filter((d) => !PROTECTED.has(d.domain));
    if (onlyDomain) candidates = candidates.filter((d) => d.domain === onlyDomain);
    if (candidates.length === 0) return NextResponse.json({ clean: true, duplicates: 0 });

    const names = candidates.map((d) => d.domain);

    // Already-pending rows: don't schedule twice.
    const pending = new Set<string>();
    {
      const { data } = await supabase
        .from("duplicate_domain_deletions")
        .select("instance,domain,status")
        .in("domain", names)
        .eq("status", "pending");
      for (const r of data || []) pending.add(`${r.instance}:${r.domain}`);
    }

    // Per-side inbox sends — crawled per workspace, not mirrored by carryover.
    const inboxSends = new Map<string, number>();
    for (let i = 0; i < names.length; i += 100) {
      const slice = names.slice(i, i + 100);
      let off = 0;
      while (true) {
        const { data, error } = await supabase
          .from("deliverability_inboxes")
          .select("instance,domain,emails_sent_count")
          .in("domain", slice)
          .range(off, off + 999);
        if (error) throw new Error(error.message);
        if (!data || data.length === 0) break;
        for (const r of data as { instance: string; domain: string; emails_sent_count: number | null }[]) {
          const k = `${r.instance}:${r.domain}`;
          inboxSends.set(k, (inboxSends.get(k) || 0) + (r.emails_sent_count || 0));
        }
        if (data.length < 1000) break;
        off += 1000;
      }
    }

    // Move direction, for the both-silent untagged case.
    const firstInstance = new Map<string, string>();
    {
      const { data } = await supabase
        .from("domain_first_created")
        .select("domain,first_instance")
        .in("domain", names);
      for (const r of data || []) firstInstance.set(r.domain, r.first_instance);
    }

    const clientTagOf = (side: DupInstance): string | null => {
      for (const t of side.tags || []) {
        const name = String(t).trim();
        if (knownTags.has(name)) return name;
      }
      return null;
    };
    const sends = (inst: string, domain: string) => inboxSends.get(`${inst}:${domain}`) || 0;

    const verdicts: Verdict[] = [];
    const needsHuman: { domain: string; reason: string; sides: string[] }[] = [];

    for (const dup of candidates) {
      const sides = dup.instances.filter((s) => isInstanceSlug(s.instance));
      const sideNames = sides.map(
        (s) => `${s.instance}(${sends(s.instance, dup.domain)} inbox-sends, tags:${(s.tags || []).join("/") || "-"})`,
      );
      if (sides.length !== 2) {
        needsHuman.push({ domain: dup.domain, reason: `${sides.length} instances`, sides: sideNames });
        continue;
      }
      const [a, b] = sides;
      if (pending.has(`${a.instance}:${dup.domain}`) || pending.has(`${b.instance}:${dup.domain}`)) continue;

      const tagA = clientTagOf(a);
      const tagB = clientTagOf(b);
      const tag = tagA || tagB;

      if (tag && tagA === tagB) {
        // Case A — same client tag on both sides; allocation decides the keeper.
        const group = allocation[tag.toUpperCase()];
        if (group == null) {
          needsHuman.push({ domain: dup.domain, reason: `tag ${tag} not in allocation sheet`, sides: sideNames });
          continue;
        }
        const keeper = sides.find((s) => getInstance(s.instance as BisonInstanceSlug).group === group);
        const other = sides.find((s) => s !== keeper);
        if (!keeper || !other) {
          needsHuman.push({ domain: dup.domain, reason: `tag ${tag}: no side in allocated group ${group}`, sides: sideNames });
          continue;
        }
        if (activeKeys.has(`${tag.toUpperCase()}:${other.instance}`)) {
          needsHuman.push({ domain: dup.domain, reason: `tag ${tag} has ACTIVE campaigns on the wrong-group side ${other.instance}`, sides: sideNames });
          continue;
        }
        verdicts.push({ domain: dup.domain, keep: keeper.instance, del: other.instance, rule: `allocated group ${group}, no active campaigns on ${other.instance}`, clientTag: tag });
        continue;
      }

      if (!tag) {
        // Case B — untagged both sides: activity decides; both-silent → keep the move destination.
        const sa = sends(a.instance, dup.domain);
        const sb = sends(b.instance, dup.domain);
        if (sa > 0 && sb > 0) {
          needsHuman.push({ domain: dup.domain, reason: "both sides have inbox sends", sides: sideNames });
          continue;
        }
        if (sa > 0 || sb > 0) {
          const keep = sa > 0 ? a : b;
          const del = sa > 0 ? b : a;
          verdicts.push({ domain: dup.domain, keep: keep.instance, del: del.instance, rule: `only ${keep.instance} has inbox sends` });
          continue;
        }
        const origin = firstInstance.get(dup.domain);
        const originSide = sides.find((s) => s.instance === origin);
        const destSide = sides.find((s) => s.instance !== origin);
        if (!origin || !originSide || !destSide) {
          needsHuman.push({ domain: dup.domain, reason: "both silent, move direction unknown", sides: sideNames });
          continue;
        }
        verdicts.push({ domain: dup.domain, keep: destSide.instance, del: originSide.instance, rule: "both silent — keeping the move destination, deleting the origin copy" });
        continue;
      }

      // Different tags per side / tagged on one side only — human.
      needsHuman.push({ domain: dup.domain, reason: `sides carry different client tags (${tagA || "-"} vs ${tagB || "-"})`, sides: sideNames });
    }

    const toSchedule = verdicts.slice(0, MAX_SCHEDULES_PER_RUN);

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        duplicates: candidates.length,
        decided: verdicts.length,
        thisRun: toSchedule.length,
        needsHuman,
        verdicts: toSchedule,
      });
    }

    if (toSchedule.length > 0) {
      // Immediate, not a 3-day window: Spencer + Nick 2026-08-26 alignment
      // call — an overlapping copy is never the one sending, so a wait
      // protects nothing and they want to wake up to zero duplicates. Grace 0
      // = the 15-minute fire-scheduled-deletions executor takes it next pass.
      // Ambiguous cases still never get here (needsHuman above).
      await scheduleDeletions(
        toSchedule.map((v) => ({ instance: v.del, domain: v.domain })),
        { source: "duplicate", graceDays: 0 },
      );
      await logEvents(
        toSchedule.map((v) => ({
          instance: v.del as BisonInstanceSlug,
          domain: v.domain,
          clientTag: v.clientTag ?? null,
          eventType: "cancel_queued" as const,
          detail: `duplicate cleanup: deleting ${v.del} copy, keeping ${v.keep} — ${v.rule}`,
        })),
      ).catch(() => {});
    }
    if (needsHuman.length > 0) {
      await logEvents(
        needsHuman.slice(0, 20).map((h) => ({
          domain: h.domain,
          eventType: "skipped" as const,
          detail: `duplicate cleanup needs a human: ${h.reason}`,
        })),
      ).catch(() => {});
    }

    return NextResponse.json({
      duplicates: candidates.length,
      scheduled: toSchedule.length,
      remainingDecided: Math.max(0, verdicts.length - toSchedule.length),
      needsHuman,
      verdicts: toSchedule,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "duplicate-cleanup failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
