import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getStoredLeads } from "@/lib/leads-store";
import { getClientTrackerData } from "@/lib/google-sheets";
import { getClientTierMap, resolveTier, TARGETS } from "@/lib/cron/client-reports";
import { evaluateClientPace, type ClientPaceEvaluation } from "@/lib/mrl-pace";
import { diagnoseRootCause, type RootCauseResult } from "@/lib/mrl-root-cause";
import { isDomainFlagged, type HealthCheckDomain } from "@/lib/inbox-health";
import { postSlackMessage } from "@/lib/slack";
import { pstDateString } from "@/lib/date-utils";
import type { Lead } from "@/types/lead";

export const maxDuration = 300;

/**
 * GET /api/cron/mrl-pace-check — daily at 16:00 UTC (8:00 AM PT, vercel.json).
 *
 * v2 (per LeadSync MRL Pacing Spec):
 *   - Business-day pacing + max-recent-velocity recoverability (mrl-pace.ts)
 *   - Ordered root-cause diagnostic + derived confidence (mrl-root-cause.ts)
 *   - Severity-transition state (severity_since / critical_since) so the
 *     panel shows "days in current severity" and the Slack digest can say
 *     "Day N Critical"
 *   - Daily Slack digest to SLACK_MRL_PACING_CHANNEL_ID: Critical clients
 *     only, one consolidated message, all-clear line on zero-Critical days.
 *     Slack failure never fails the cron.
 *
 * All inputs come from already-synced stores (leads-store Redis, Supabase
 * campaigns / deliverability tables, cached Client Tracker) — zero live
 * Bison or Google Sheets calls; completes in seconds.
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
  name: string | null;
  status: string | null;
  total_leads: number | null;
  remaining_leads: number | null;
}

interface DomainRow extends HealthCheckDomain {
  domain: string;
  tags: string[] | null;
}

interface InboxRow {
  domain: string | null;
  status: string | null;
  tags: { name?: string }[] | null;
}

interface ExistingStateRow {
  client_tag: string;
  severity: string;
  severity_since: string | null;
  critical_since: string | null;
}

function looksDisconnected(status: string): boolean {
  return (
    status.includes("disconnect") ||
    status.includes("reconnection") ||
    status.includes("login failed") ||
    status.includes("auth failed")
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysSince(iso: string | null, now: Date): number {
  if (!iso) return 1;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 1;
  return Math.max(1, Math.floor((now.getTime() - t) / DAY_MS) + 1);
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

    const { data: campaignRowsRaw, error: campErr } = await supabase
      .from("campaigns")
      .select("client_tag, name, status, total_leads, remaining_leads");
    if (campErr) throw new Error(`campaigns read: ${campErr.message}`);
    const campaignRows = (campaignRowsRaw || []) as CampaignRow[];

    const domainRows: DomainRow[] = [];
    {
      const PAGE = 1000;
      let offset = 0;
      while (true) {
        const { data, error } = await supabase
          .from("deliverability_domains")
          .select("domain, tags, total_sent, total_replied, total_bounced, google_count, outlook_count")
          .range(offset, offset + PAGE - 1);
        if (error) throw new Error(`domains read: ${error.message}`);
        if (!data || data.length === 0) break;
        domainRows.push(...(data as DomainRow[]));
        if (data.length < PAGE) break;
        offset += PAGE;
      }
    }

    // Sender accounts (for the healthy/total capacity check). Account-level
    // per the spec: healthy = not disconnected-like AND domain not flagged.
    const inboxRows: InboxRow[] = [];
    {
      const PAGE = 1000;
      let offset = 0;
      while (true) {
        const { data, error } = await supabase
          .from("deliverability_inboxes")
          .select("domain, status, tags")
          .range(offset, offset + PAGE - 1);
        if (error) throw new Error(`inboxes read: ${error.message}`);
        if (!data || data.length === 0) break;
        inboxRows.push(...(data as InboxRow[]));
        if (data.length < PAGE) break;
        offset += PAGE;
      }
    }
    const flaggedDomainSet = new Set(
      domainRows.filter((d) => isDomainFlagged(d)).map((d) => d.domain),
    );

    // Existing rows — for severity transition state.
    const existingState = new Map<string, ExistingStateRow>();
    {
      const { data } = await supabase
        .from("client_mrl_pace_status")
        .select("client_tag, severity, severity_since, critical_since");
      for (const r of (data || []) as ExistingStateRow[]) {
        existingState.set(r.client_tag, r);
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

    const trackerByAbbr = new Map<string, (typeof tracker)[number]>();
    for (const row of tracker) {
      for (const cand of tagCandidates(row.clientAbbr)) {
        if (!trackerByAbbr.has(cand)) trackerByAbbr.set(cand, row);
      }
    }

    // ── Evaluate each client ──────────────────────────────────────────
    const now = new Date();
    const nowIso = now.toISOString();
    const evaluated: string[] = [];
    const upserts: Record<string, unknown>[] = [];
    const criticalForDigest: Array<{
      eval_: ClientPaceEvaluation;
      rootCause: RootCauseResult | null;
      dayN: number;
    }> = [];
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

      // Per-client campaign aggregates (synced table — all instances).
      const clientCampaigns = campaignRows.filter(
        (c) => c.client_tag && candidates.has(c.client_tag.trim().toUpperCase()),
      );
      const nonArchived = clientCampaigns.filter(
        (c) => (c.status || "").trim().toLowerCase() !== "archived",
      );
      const totalContacts = nonArchived.reduce((s, c) => s + Math.max(0, c.total_leads || 0), 0);
      const leadsInPipeline = clientCampaigns
        .filter((c) => PIPELINE_STATUSES.has((c.status || "").trim().toLowerCase()))
        .reduce((s, c) => s + Math.max(0, c.remaining_leads || 0), 0);
      const nurtureCampaigns = nonArchived.filter((c) =>
        (c.name || "").includes("[Nurture]"),
      ).length;
      const failedCampaigns = clientCampaigns.filter(
        (c) => (c.status || "").trim().toLowerCase() === "failed",
      ).length;

      // Per-client sender-account health.
      const clientInboxes = inboxRows.filter(
        (i) =>
          Array.isArray(i.tags) &&
          i.tags.some((t) => candidates.has((t?.name || "").trim().toUpperCase())),
      );
      const totalAccounts = clientInboxes.length;
      const healthyAccounts = clientInboxes.filter((i) => {
        if (looksDisconnected((i.status || "").toLowerCase())) return false;
        if (i.domain && flaggedDomainSet.has(i.domain)) return false;
        return true;
      }).length;

      const eval_ = evaluateClientPace({
        clientTag,
        companyName: trackerRow?.companyName || clientTag,
        plan: tier.plan,
        threshold: TARGETS[tier.bucket].mrMonthly,
        cycleAnchor: anchor,
        leads: clientLeads,
        now,
      });

      // Root cause only for flagged clients.
      const rootCause: RootCauseResult | null =
        eval_.severity === "on_track"
          ? null
          : diagnoseRootCause({
              totalContacts,
              healthyAccounts,
              totalAccounts,
              nurtureCampaigns,
              failedCampaigns,
            });

      // Severity transition state.
      const prev = existingState.get(clientTag);
      const severityChanged = !prev || prev.severity !== eval_.severity;
      const severitySince = severityChanged ? nowIso : (prev?.severity_since ?? nowIso);
      let criticalSince: string | null = null;
      if (eval_.severity === "critical") {
        criticalSince = prev?.critical_since && prev.severity === "critical"
          ? prev.critical_since
          : nowIso;
      }

      evaluated.push(clientTag);
      upserts.push({
        client_tag: eval_.clientTag,
        company_name: eval_.companyName,
        plan: eval_.plan,
        evaluated_at: nowIso,
        cycle_start: eval_.cycleStart,
        cycle_end: eval_.cycleEnd,
        cycle_length: eval_.cycleLength,
        days_elapsed: eval_.daysElapsed,
        days_remaining: eval_.daysRemaining,
        biz_days_total: eval_.bizDaysTotal,
        biz_days_elapsed: eval_.bizDaysElapsed,
        biz_days_remaining: eval_.bizDaysRemaining,
        threshold: eval_.threshold,
        actual_mrls: eval_.actualMrls,
        expected_mrls_to_date: eval_.expectedMrlsToDate,
        pace_ratio: eval_.paceRatio,
        pct_behind: eval_.pctBehind,
        velocity_7d: eval_.velocity7d,
        max_velocity_7d: eval_.maxVelocity7d,
        velocity_daily: eval_.velocityDaily,
        projected_total: eval_.projectedTotal,
        prior_cycle_at_same_day: eval_.priorCycleActualAtSameDay,
        prior_cycle_total: eval_.priorCycleTotal,
        is_first_cycle: eval_.isFirstCycle,
        historically_recovers: eval_.historicallyRecovers,
        severity: eval_.severity,
        root_cause_hint: eval_.inGracePeriod
          ? "in_grace_period"
          : rootCause?.tag ?? "on_track",
        root_cause_detail: rootCause?.detail ?? null,
        root_cause_confidence: rootCause?.confidence ?? null,
        severity_since: severitySince,
        critical_since: criticalSince,
        signals: {
          leadsInPipeline,
          totalContacts,
          healthyAccounts,
          totalAccounts,
          nurtureCampaigns,
          failedCampaigns,
        },
      });

      if (eval_.severity === "critical" && !eval_.inGracePeriod) {
        criticalForDigest.push({
          eval_,
          rootCause,
          dayN: daysSince(criticalSince, now),
        });
      }
    }

    // ── Persist ───────────────────────────────────────────────────────
    for (let i = 0; i < upserts.length; i += 500) {
      const { error } = await supabase
        .from("client_mrl_pace_status")
        .upsert(upserts.slice(i, i + 500), { onConflict: "client_tag" });
      if (error) throw new Error(`upsert: ${error.message}`);
    }

    // Prune rows for clients that no longer evaluate.
    let pruned = 0;
    {
      const keep = new Set(evaluated);
      const stale = [...existingState.keys()].filter((t) => !keep.has(t));
      for (const tag of stale) {
        const { error } = await supabase
          .from("client_mrl_pace_status")
          .delete()
          .eq("client_tag", tag);
        if (!error) pruned++;
      }
    }

    // ── Slack digest (Critical only + all-clear). Never fails the cron. ──
    const digestDate = pstDateString(now);
    let slackResult: { ok: boolean; reason?: string } = { ok: false, reason: "not attempted" };
    try {
      const channel = process.env.SLACK_MRL_PACING_CHANNEL_ID;
      let text: string;
      if (criticalForDigest.length === 0) {
        text = `:white_check_mark: *MRL Pacing* — no clients Critical today (${digestDate})`;
      } else {
        // Worst first — same ordering as the panel.
        criticalForDigest.sort((a, b) => b.eval_.pctBehind - a.eval_.pctBehind);
        const lines = criticalForDigest.map(({ eval_: e, rootCause, dayN }) => {
          const notes: string[] = [];
          if (e.isFirstCycle) notes.push("first cycle — expected ramp");
          if (e.historicallyRecovers) notes.push("historically recovers");
          const noteStr = notes.length ? ` · _${notes.join(" · ")}_` : "";
          const cause = rootCause
            ? ` · ${rootCause.detail} (${rootCause.confidence === "high" ? "High" : "Medium"})`
            : "";
          return `• *${e.clientTag}* — ${e.actualMrls}/${Math.round(e.expectedMrlsToDate)} MRLs · ${e.bizDaysRemaining} biz days left · projected ${e.projectedTotal} vs ${e.threshold}${cause} · Day ${dayN} Critical${noteStr}`;
        });
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://google-sheets-dashboard-nine.vercel.app";
        text = [
          `:warning: *MRL Pacing — ${criticalForDigest.length} client${criticalForDigest.length === 1 ? "" : "s"} Critical* (${digestDate})`,
          ...lines,
          `<${appUrl}|Open the pacing panel>`,
        ].join("\n");
      }
      slackResult = await postSlackMessage(text, channel);
      if (!slackResult.ok) console.warn(`[cron/mrl-pace] Slack digest failed: ${slackResult.reason}`);
    } catch (e) {
      slackResult = { ok: false, reason: e instanceof Error ? e.message : "slack threw" };
      console.warn(`[cron/mrl-pace] Slack digest threw:`, e);
    }

    const bySeverity = { on_track: 0, at_risk: 0, critical: 0 };
    for (const u of upserts) {
      const s = u.severity as keyof typeof bySeverity;
      if (s in bySeverity) bySeverity[s]++;
    }

    const durationMs = Date.now() - t0;
    console.log(
      `[cron/mrl-pace] evaluated=${evaluated.length} on_track=${bySeverity.on_track} at_risk=${bySeverity.at_risk} critical=${bySeverity.critical} skipped(untiered=${skippedUntiered} inactive=${skippedInactive} noAnchor=${skippedNoAnchor}) pruned=${pruned} slack=${slackResult.ok} duration=${durationMs}ms`,
    );

    return NextResponse.json({
      ok: true,
      evaluated: evaluated.length,
      ...bySeverity,
      skippedUntiered,
      skippedInactive,
      skippedNoAnchor,
      pruned,
      slack: slackResult,
      durationMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "mrl-pace-check failed";
    console.error("[cron/mrl-pace]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
