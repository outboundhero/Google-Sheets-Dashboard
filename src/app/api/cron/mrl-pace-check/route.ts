import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getStoredLeads } from "@/lib/leads-store";
import { getClientTrackerData } from "@/lib/google-sheets";
import { getClientTierMap, resolveTier, TARGETS } from "@/lib/cron/client-reports";
import { evaluateClientPace } from "@/lib/mrl-pace";
import type { Lead } from "@/types/lead";
import type { HealthCheckDomain } from "@/lib/inbox-health";

export const maxDuration = 300;

/**
 * GET /api/cron/mrl-pace-check — every 4 hours (vercel.json).
 *
 * Recomputes each Active tiered client's MRL pace for their current billing
 * cycle and upserts one row per client into `client_mrl_pace_status`. The
 * dashboard's "Clients off-pace for MRL threshold" panel reads that table via
 * /api/mrl-pace-status. Fully self-resolving: severity is recomputed fresh
 * every run, so clients age on/off the panel with no manual state.
 *
 * Data sources (all already-synced stores — NO Google Sheets reads, so this
 * is fast and quota-free):
 *   - leads:      leads-store (Redis) — synced by the daily lead-sync cron
 *   - threshold:  Client Tracker tier map (cached sheet read)
 *   - cycle:      Client Tracker startDate/goLiveDate
 *   - pipeline:   Supabase `campaigns.remaining_leads`
 *   - infra:      Supabase `deliverability_domains` + shared health rule
 *
 * Freshness note: lead counts are as fresh as the last lead sync (≤24h).
 * Pace moves on day granularity, so that's within tolerance.
 */

// Split a (possibly combined) client tag into candidate abbreviations —
// "JPCIN / JPCHI" → {JPCIN / JPCHI, JPCIN, JPCHI}. Mirrors resolveTier's rule.
function tagCandidates(clientTag: string): Set<string> {
  const out = new Set<string>();
  const whole = clientTag.trim().toUpperCase();
  if (whole) out.add(whole);
  for (const slash of clientTag.split("/")) {
    for (const amp of slash.split(" & ")) {
      const v = amp.trim().toUpperCase();
      if (v) out.add(v);
    }
  }
  return out;
}

// Live campaign statuses whose remaining leads count as active pipeline.
const PIPELINE_STATUSES = new Set(["active", "launching", "queued"]);

interface CampaignRow {
  client_tag: string | null;
  status: string | null;
  remaining_leads: number | null;
}

interface DomainRow extends HealthCheckDomain {
  tags: string[] | null;
}

export async function GET() {
  const t0 = Date.now();
  const supabase = getSupabaseAdmin();

  try {
    // ── Load everything once ──────────────────────────────────────────
    const [leads, tracker, tierMap] = await Promise.all([
      getStoredLeads(),
      getClientTrackerData(),
      getClientTierMap(),
    ]);

    const { data: campaignRows, error: campErr } = await supabase
      .from("campaigns")
      .select("client_tag, status, remaining_leads");
    if (campErr) throw new Error(`campaigns read: ${campErr.message}`);

    const domainRows: DomainRow[] = [];
    {
      const PAGE = 1000;
      let offset = 0;
      while (true) {
        const { data, error } = await supabase
          .from("deliverability_domains")
          .select("tags, total_sent, total_replied, total_bounced, google_count, outlook_count")
          .range(offset, offset + PAGE - 1);
        if (error) throw new Error(`domains read: ${error.message}`);
        if (!data || data.length === 0) break;
        domainRows.push(...(data as DomainRow[]));
        if (data.length < PAGE) break;
        offset += PAGE;
      }
    }

    // ── Group leads by sheet client tag ───────────────────────────────
    const leadsByTag = new Map<string, Lead[]>();
    for (const lead of leads) {
      const tag = (lead.sheetClientTag || lead.clientTag || "").trim();
      if (!tag) continue;
      let arr = leadsByTag.get(tag);
      if (!arr) { arr = []; leadsByTag.set(tag, arr); }
      arr.push(lead);
    }

    // Tracker lookup by candidate abbreviation for cycle anchor + company name.
    const trackerByAbbr = new Map<string, (typeof tracker)[number]>();
    for (const row of tracker) {
      for (const cand of tagCandidates(row.clientAbbr)) {
        if (!trackerByAbbr.has(cand)) trackerByAbbr.set(cand, row);
      }
    }

    // ── Evaluate each client ──────────────────────────────────────────
    const now = new Date();
    const evaluated: string[] = [];
    const upserts: Record<string, unknown>[] = [];
    let skippedUntiered = 0;
    let skippedInactive = 0;
    let skippedNoAnchor = 0;

    for (const [clientTag, clientLeads] of leadsByTag) {
      const tier = resolveTier(clientTag, tierMap);
      if (!tier || !tier.bucket) { skippedUntiered++; continue; }
      if (!/active/i.test(tier.status)) { skippedInactive++; continue; }

      const candidates = tagCandidates(clientTag);
      let trackerRow: (typeof tracker)[number] | undefined;
      for (const cand of candidates) {
        trackerRow = trackerByAbbr.get(cand);
        if (trackerRow) break;
      }
      const anchorStr = trackerRow?.startDate || trackerRow?.goLiveDate;
      const anchor = anchorStr ? new Date(anchorStr) : null;
      if (!anchor || isNaN(anchor.getTime()) || anchor > now) { skippedNoAnchor++; continue; }

      const leadsInPipeline = ((campaignRows || []) as CampaignRow[])
        .filter(
          (c) =>
            c.client_tag &&
            candidates.has(c.client_tag.trim().toUpperCase()) &&
            PIPELINE_STATUSES.has((c.status || "").trim().toLowerCase()),
        )
        .reduce((sum, c) => sum + Math.max(0, c.remaining_leads || 0), 0);

      const clientDomains = domainRows.filter(
        (d) =>
          Array.isArray(d.tags) &&
          d.tags.some((t) => candidates.has((t || "").trim().toUpperCase())),
      );

      const result = evaluateClientPace({
        clientTag,
        companyName: trackerRow?.companyName || clientTag,
        plan: tier.plan,
        threshold: TARGETS[tier.bucket].mrMonthly,
        cycleAnchor: anchor,
        leads: clientLeads,
        leadsInPipeline,
        domains: clientDomains,
        now,
      });

      evaluated.push(clientTag);
      upserts.push({
        client_tag: result.clientTag,
        company_name: result.companyName,
        plan: result.plan,
        evaluated_at: now.toISOString(),
        cycle_start: result.cycleStart,
        cycle_end: result.cycleEnd,
        cycle_length: result.cycleLength,
        days_elapsed: result.daysElapsed,
        days_remaining: result.daysRemaining,
        threshold: result.threshold,
        actual_mrls: result.actualMrls,
        expected_mrls_to_date: result.expectedMrlsToDate,
        pace_ratio: result.paceRatio,
        velocity_7d: result.velocity7d,
        projected_total: result.projectedTotal,
        prior_cycle_at_same_day: result.priorCycleActualAtSameDay,
        prior_cycle_total: result.priorCycleTotal,
        severity: result.severity,
        root_cause_hint: result.rootCauseHint,
        signals: result.signals,
      });
    }

    // ── Persist ───────────────────────────────────────────────────────
    for (let i = 0; i < upserts.length; i += 500) {
      const { error } = await supabase
        .from("client_mrl_pace_status")
        .upsert(upserts.slice(i, i + 500), { onConflict: "client_tag" });
      if (error) throw new Error(`upsert: ${error.message}`);
    }

    // Prune rows for clients that no longer evaluate (churned, untiered,
    // sheet removed) so stale flags never linger on the panel.
    let pruned = 0;
    {
      const { data: existing } = await supabase
        .from("client_mrl_pace_status")
        .select("client_tag");
      const keep = new Set(evaluated);
      const stale = ((existing || []) as { client_tag: string }[])
        .map((r) => r.client_tag)
        .filter((t) => !keep.has(t));
      for (const tag of stale) {
        const { error } = await supabase
          .from("client_mrl_pace_status")
          .delete()
          .eq("client_tag", tag);
        if (!error) pruned++;
      }
    }

    const bySeverity = { on_track: 0, at_risk: 0, critical: 0 };
    for (const u of upserts) {
      const s = u.severity as keyof typeof bySeverity;
      if (s in bySeverity) bySeverity[s]++;
    }

    const durationMs = Date.now() - t0;
    console.log(
      `[cron/mrl-pace] evaluated=${evaluated.length} on_track=${bySeverity.on_track} at_risk=${bySeverity.at_risk} critical=${bySeverity.critical} skipped(untiered=${skippedUntiered} inactive=${skippedInactive} noAnchor=${skippedNoAnchor}) pruned=${pruned} duration=${durationMs}ms`,
    );

    return NextResponse.json({
      ok: true,
      evaluated: evaluated.length,
      ...bySeverity,
      skippedUntiered,
      skippedInactive,
      skippedNoAnchor,
      pruned,
      durationMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "mrl-pace-check failed";
    console.error("[cron/mrl-pace]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
