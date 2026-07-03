import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

/**
 * GET /api/mrl-pace-status
 *
 * Feeds the "Clients Off-Pace for MRL Threshold" panel. v2 returns ALL three
 * tiers (On Track included, for the collapsed audit section) minus
 * grace-period rows. Sorted: critical → at_risk → on_track, then worst
 * pace-gap (pct_behind desc) within each tier.
 *
 * Recomputed daily by /api/cron/mrl-pace-check (16:00 UTC = 8 AM PT) — rows
 * appear, downgrade, and disappear on their own with no manual state.
 */

interface PaceRow {
  client_tag: string;
  company_name: string | null;
  plan: string | null;
  evaluated_at: string;
  cycle_start: string;
  cycle_end: string;
  cycle_length: number;
  days_elapsed: number;
  days_remaining: number;
  biz_days_total: number | null;
  biz_days_elapsed: number | null;
  biz_days_remaining: number | null;
  threshold: number;
  actual_mrls: number;
  expected_mrls_to_date: number;
  pace_ratio: number | null;
  pct_behind: number | null;
  velocity_7d: number;
  max_velocity_7d: number | null;
  velocity_daily: number[] | null;
  projected_total: number;
  prior_cycle_at_same_day: number | null;
  prior_cycle_total: number | null;
  is_first_cycle: boolean | null;
  historically_recovers: boolean | null;
  severity: string;
  root_cause_hint: string;
  root_cause_detail: string | null;
  root_cause_confidence: string | null;
  severity_since: string | null;
  critical_since: string | null;
  signals: {
    leadsInPipeline?: number;
    totalContacts?: number;
    healthyAccounts?: number;
    totalAccounts?: number;
    nurtureCampaigns?: number;
    failedCampaigns?: number;
  } | null;
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, at_risk: 1, on_track: 2 };
const DAY_MS = 24 * 60 * 60 * 1000;

function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(1, Math.floor((now.getTime() - t) / DAY_MS) + 1);
}

export async function GET() {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.from("client_mrl_pace_status").select("*");
    if (error) throw new Error(error.message);

    const now = new Date();
    const rows = ((data || []) as PaceRow[])
      .filter((r) => r.root_cause_hint !== "in_grace_period")
      .sort((a, b) => {
        const so = (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3);
        if (so !== 0) return so;
        return (b.pct_behind ?? 0) - (a.pct_behind ?? 0);
      });

    const clients = rows.map((r) => ({
      clientTag: r.client_tag,
      companyName: r.company_name || r.client_tag,
      plan: r.plan || "",
      threshold: r.threshold,
      cycleStart: r.cycle_start,
      cycleEnd: r.cycle_end,
      cycleLength: r.cycle_length,
      daysElapsed: r.days_elapsed,
      daysRemaining: r.days_remaining,
      bizDaysTotal: r.biz_days_total ?? 0,
      bizDaysElapsed: r.biz_days_elapsed ?? 0,
      bizDaysRemaining: r.biz_days_remaining ?? 0,
      actualMrls: r.actual_mrls,
      expectedMrlsToDate: r.expected_mrls_to_date,
      pctBehind: r.pct_behind ?? 0,
      velocity7d: r.velocity_7d,
      maxVelocity7d: r.max_velocity_7d ?? r.velocity_7d,
      velocityDaily: Array.isArray(r.velocity_daily) ? r.velocity_daily : [],
      projectedTotal: r.projected_total,
      priorCycleActualAtSameDay: r.prior_cycle_at_same_day,
      priorCycleTotal: r.prior_cycle_total,
      isFirstCycle: r.is_first_cycle ?? false,
      historicallyRecovers: r.historically_recovers ?? false,
      severity: r.severity as "critical" | "at_risk" | "on_track",
      rootCauseTag: r.root_cause_hint,
      rootCauseDetail: r.root_cause_detail,
      rootCauseConfidence: (r.root_cause_confidence as "high" | "medium" | null) ?? null,
      daysInSeverity: daysSince(r.severity_since, now),
      dayNCritical: r.severity === "critical" ? daysSince(r.critical_since, now) : null,
      signals: {
        leadsInPipeline: r.signals?.leadsInPipeline ?? 0,
        totalContacts: r.signals?.totalContacts ?? 0,
        healthyAccounts: r.signals?.healthyAccounts ?? 0,
        totalAccounts: r.signals?.totalAccounts ?? 0,
        nurtureCampaigns: r.signals?.nurtureCampaigns ?? 0,
        failedCampaigns: r.signals?.failedCampaigns ?? 0,
      },
    }));

    const evaluatedAt = rows.length > 0
      ? rows.map((r) => r.evaluated_at).sort().slice(-1)[0]
      : null;

    return NextResponse.json({ clients, evaluatedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
