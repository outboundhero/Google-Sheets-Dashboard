import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

/**
 * GET /api/mrl-pace-status
 *
 * Feeds the dashboard's "Clients off-pace for MRL threshold" panel. Returns
 * only clients currently At Risk or Critical (grace-period and on-track rows
 * stay in the table for auditing but never reach the panel), sorted worst
 * first: Critical before At Risk, then ascending pace ratio within a bucket.
 *
 * Recomputed by /api/cron/mrl-pace-check every 4 hours — rows appear,
 * downgrade, and disappear on their own with no manual state.
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
  threshold: number;
  actual_mrls: number;
  expected_mrls_to_date: number;
  pace_ratio: number | null;
  velocity_7d: number;
  projected_total: number;
  prior_cycle_at_same_day: number | null;
  prior_cycle_total: number | null;
  severity: string;
  root_cause_hint: string;
  signals: { leadsInPipeline?: number; healthyDomains?: number; flaggedDomains?: number } | null;
}

export async function GET() {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("client_mrl_pace_status")
      .select("*")
      .in("severity", ["at_risk", "critical"]);
    if (error) throw new Error(error.message);

    const rows = ((data || []) as PaceRow[])
      .filter((r) => r.root_cause_hint !== "in_grace_period")
      .sort((a, b) => {
        if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
        return (a.pace_ratio ?? 0) - (b.pace_ratio ?? 0);
      });

    const flagged = rows.map((r) => ({
      clientTag: r.client_tag,
      companyName: r.company_name || r.client_tag,
      plan: r.plan || "",
      threshold: r.threshold,
      cycleStart: r.cycle_start,
      cycleEnd: r.cycle_end,
      cycleLength: r.cycle_length,
      daysElapsed: r.days_elapsed,
      daysRemaining: r.days_remaining,
      actualMrls: r.actual_mrls,
      expectedMrlsToDate: r.expected_mrls_to_date,
      paceRatio: r.pace_ratio ?? 0,
      velocity7d: r.velocity_7d,
      projectedTotal: r.projected_total,
      priorCycleActualAtSameDay: r.prior_cycle_at_same_day,
      severity: r.severity as "at_risk" | "critical",
      rootCauseHint: r.root_cause_hint,
      signals: {
        leadsInPipeline: r.signals?.leadsInPipeline ?? 0,
        healthyDomains: r.signals?.healthyDomains ?? 0,
        flaggedDomains: r.signals?.flaggedDomains ?? 0,
      },
    }));

    const evaluatedAt = rows.length > 0
      ? rows.map((r) => r.evaluated_at).sort().slice(-1)[0]
      : null;

    return NextResponse.json({ flagged, evaluatedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
