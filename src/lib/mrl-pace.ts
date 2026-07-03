// MRL pace evaluation — the pure calculator behind the "Clients off-pace for
// MRL threshold" dashboard panel.
//
// For one client it answers: given their billing cycle, tier threshold, and
// delivered MRLs so far, are they On Track / At Risk / Critical — and if
// they're behind, what's the most likely reason?
//
// Everything here is pure (no I/O): the cron loads leads / campaigns /
// domains once and calls evaluateClientPace per client. Keeping it pure makes
// the pace math trivially testable and reusable.
//
// Definitions (all reuse existing codebase conventions):
//   MRL           = "deliverable" lead per makeDeliverablePredicate() —
//                   currentCategory contains "meeting", falling back to
//                   status === "Quality Lead" for clients whose sheets never
//                   set currentCategory (e.g. BHS).
//   delivery date = timeWeGotReply || replyTime (analytics.ts convention)
//   billing cycle = monthly anniversary of the client's Start Date (falls
//                   back to Go Live Date), same anchoring as the analytics
//                   billing-month buckets. Cycle length is the real number of
//                   days between anniversaries (28–31), not hardcoded 30.
//   threshold     = tier target from the Client Tracker "Plan" column
//                   (T0.5/1 → 20 MRLs, T2 → 40) — client-reports.ts TARGETS.

import type { Lead } from "@/types/lead";
import { parseDate, makeDeliverablePredicate } from "@/lib/analytics";
import { isDomainFlagged, isDomainAssessable, type HealthCheckDomain } from "@/lib/inbox-health";

export type PaceSeverity = "on_track" | "at_risk" | "critical";
export type PaceRootCause =
  | "low_infrastructure"
  | "low_pipeline"
  | "leads_not_converting"
  | "velocity_dropping"
  | "unknown"
  | "in_grace_period";

// Tuning knobs — exported so any future admin surface shows the real values.
export const GRACE_PERIOD_DAYS = 7;       // don't evaluate before day 7 of a cycle
export const PACE_ON_TRACK = 0.9;         // ≥90% of expected pace → on_track
export const PACE_AT_RISK_MIN = 0.6;      // ≥60% (or recoverable) → at_risk, below → critical
// Root-cause heuristic: to close a gap of N MRLs, the client needs roughly
// N × this many uncontacted leads in campaigns (assumes a ~3% lead→MRL
// conversion; deliberately conservative so `low_pipeline` only fires when the
// pipeline is genuinely thin, not merely tight).
export const PIPELINE_LEADS_PER_MRL = 30;

export interface PaceSignals {
  leadsInPipeline: number;
  healthyDomains: number;
  flaggedDomains: number;
}

export interface ClientPaceEvaluation {
  clientTag: string;
  companyName: string;
  plan: string;
  threshold: number;
  cycleStart: string;      // ISO date (yyyy-mm-dd)
  cycleEnd: string;
  cycleLength: number;     // real days in this cycle (28–31)
  daysElapsed: number;     // day 1 = cycle start day
  daysRemaining: number;
  actualMrls: number;
  expectedMrlsToDate: number;
  paceRatio: number;                       // actual / expected (1 = exactly on pace)
  velocity7d: number;                      // MRLs per day over the trailing 7 days
  projectedTotal: number;                  // actual + velocity7d × daysRemaining
  priorCycleActualAtSameDay: number | null; // same-day-of-cycle count last cycle (null = no prior cycle)
  priorCycleTotal: number | null;
  severity: PaceSeverity;
  signals: PaceSignals;
  rootCauseHint: PaceRootCause;
}

export interface EvaluateClientPaceInput {
  clientTag: string;
  companyName: string;
  plan: string;
  /** Tier monthly MRL target (TARGETS[bucket].mrMonthly). */
  threshold: number;
  /** Billing anchor — client's Start Date, falling back to Go Live Date. */
  cycleAnchor: Date;
  /** All leads for this client's sheet(s). */
  leads: Lead[];
  /** Sum of remaining (uncontacted) leads across the client's live campaigns. */
  leadsInPipeline: number;
  /** The client's tagged domains, for infrastructure health. */
  domains: HealthCheckDomain[];
  /** Injected clock, defaults to now. */
  now?: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Monthly anniversary of `anchor` shifted by `months`, clamped for short months
 *  (anchor on the 31st → Feb gives Feb 28/29), matching JS Date rollover-free math. */
function anniversary(anchor: Date, months: number): Date {
  const y = anchor.getFullYear();
  const m = anchor.getMonth() + months;
  const day = anchor.getDate();
  const lastDayOfTarget = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(day, lastDayOfTarget));
}

/** Latest cycle start ≤ now, as a whole number of months after the anchor. */
function currentCycleStart(anchor: Date, now: Date): { start: Date; index: number } {
  // Approximate month count, then correct by stepping.
  let months =
    (now.getFullYear() - anchor.getFullYear()) * 12 + (now.getMonth() - anchor.getMonth());
  if (anniversary(anchor, months) > now) months--;
  while (anniversary(anchor, months + 1) <= now) months++;
  return { start: anniversary(anchor, Math.max(0, months)), index: Math.max(0, months) };
}

export function evaluateClientPace(input: EvaluateClientPaceInput): ClientPaceEvaluation {
  const now = input.now ?? new Date();
  const { start: cycleStart, index: cycleIndex } = currentCycleStart(input.cycleAnchor, now);
  const cycleEnd = anniversary(input.cycleAnchor, cycleIndex + 1);
  const cycleLength = Math.max(1, Math.round((cycleEnd.getTime() - cycleStart.getTime()) / DAY_MS));
  const daysElapsed = Math.min(
    cycleLength,
    Math.floor((now.getTime() - cycleStart.getTime()) / DAY_MS) + 1,
  );
  const daysRemaining = Math.max(0, cycleLength - daysElapsed);

  // ── Count deliverables ────────────────────────────────────────────────
  const isDeliverable = makeDeliverablePredicate(input.leads);
  const deliveredAt: Date[] = [];
  for (const lead of input.leads) {
    if (!isDeliverable(lead)) continue;
    const d = parseDate(lead.timeWeGotReply) || parseDate(lead.replyTime);
    if (d) deliveredAt.push(d);
  }

  const actualMrls = deliveredAt.filter((d) => d >= cycleStart && d <= now).length;

  const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS);
  const last7 = deliveredAt.filter((d) => d > sevenDaysAgo && d <= now).length;
  const velocity7d = last7 / 7;

  // Prior cycle (for the "vs last cycle at the same day" line + the
  // velocity_dropping heuristic). Only when the client has completed ≥1 cycle.
  let priorCycleActualAtSameDay: number | null = null;
  let priorCycleTotal: number | null = null;
  if (cycleIndex >= 1) {
    const prevStart = anniversary(input.cycleAnchor, cycleIndex - 1);
    const prevSameDay = new Date(prevStart.getTime() + daysElapsed * DAY_MS);
    priorCycleActualAtSameDay = deliveredAt.filter((d) => d >= prevStart && d < prevSameDay).length;
    priorCycleTotal = deliveredAt.filter((d) => d >= prevStart && d < cycleStart).length;
  }

  // ── Pace math ─────────────────────────────────────────────────────────
  const expectedMrlsToDate = (daysElapsed / cycleLength) * input.threshold;
  const paceRatio = expectedMrlsToDate > 0 ? actualMrls / expectedMrlsToDate : 1;
  const projectedTotal = Math.round(actualMrls + velocity7d * daysRemaining);

  // ── Signals ───────────────────────────────────────────────────────────
  const assessable = input.domains.filter(isDomainAssessable);
  const flaggedDomains = assessable.filter(isDomainFlagged).length;
  const healthyDomains = assessable.length - flaggedDomains;
  const signals: PaceSignals = {
    leadsInPipeline: input.leadsInPipeline,
    healthyDomains,
    flaggedDomains,
  };

  const base = {
    clientTag: input.clientTag,
    companyName: input.companyName,
    plan: input.plan,
    threshold: input.threshold,
    cycleStart: isoDate(cycleStart),
    cycleEnd: isoDate(cycleEnd),
    cycleLength,
    daysElapsed,
    daysRemaining,
    actualMrls,
    expectedMrlsToDate: Math.round(expectedMrlsToDate * 10) / 10,
    paceRatio: Math.round(paceRatio * 100) / 100,
    velocity7d: Math.round(velocity7d * 100) / 100,
    projectedTotal,
    priorCycleActualAtSameDay,
    priorCycleTotal,
    signals,
  };

  // ── Grace period ──────────────────────────────────────────────────────
  if (daysElapsed < GRACE_PERIOD_DAYS) {
    return { ...base, severity: "on_track", rootCauseHint: "in_grace_period" };
  }

  // ── Severity ──────────────────────────────────────────────────────────
  let severity: PaceSeverity;
  if (paceRatio >= PACE_ON_TRACK) {
    severity = "on_track";
  } else if (paceRatio >= PACE_AT_RISK_MIN || projectedTotal >= input.threshold) {
    severity = "at_risk";
  } else {
    severity = "critical";
  }

  if (severity === "on_track") {
    return { ...base, severity, rootCauseHint: "unknown" };
  }

  // ── Root cause (heuristic, first match wins) ─────────────────────────
  const mrlsNeeded = Math.max(0, input.threshold - actualMrls);
  let rootCauseHint: PaceRootCause = "unknown";
  if (assessable.length > 0 && flaggedDomains > healthyDomains) {
    rootCauseHint = "low_infrastructure";
  } else if (input.leadsInPipeline < mrlsNeeded * PIPELINE_LEADS_PER_MRL) {
    rootCauseHint = "low_pipeline";
  } else if (daysRemaining > 0 && velocity7d < (mrlsNeeded / daysRemaining) * 0.5) {
    // Plenty of pipeline + healthy infra, but delivering at less than half
    // the rate needed from here → leads aren't converting to MRLs.
    rootCauseHint = "leads_not_converting";
  } else if (
    priorCycleTotal !== null &&
    priorCycleTotal > 0 &&
    velocity7d < (priorCycleTotal / cycleLength) * 0.6
  ) {
    rootCauseHint = "velocity_dropping";
  }

  return { ...base, severity, rootCauseHint };
}
