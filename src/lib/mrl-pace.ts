// MRL pace evaluation (v2) — the pure calculator behind the "Clients off-pace
// for MRL threshold" panel + daily Slack digest.
//
// v2 changes vs v1 (per the client's build spec, LeadSync MRL Pacing Spec.pdf):
//   - Pace on BUSINESS DAYS (Mon–Fri), not calendar days. We only send
//     weekdays, so calendar pacing made every client look behind after each
//     weekend.
//   - Recoverability uses MAX recent velocity — the client's best 7-day
//     rolling MRL rate (per business day) in the trailing 28 days — not the
//     current rate. "Unrecoverable" now means: even at their best recent
//     form they'd miss the threshold.
//   - New severity bands: On Track ≤10% behind pace · At Risk 10–30% behind
//     AND recoverable · Critical >30% behind OR unrecoverable.
//   - Hard Critical override: ≤3 business days remaining and still below
//     threshold → forced Critical regardless of the math.
//   - First-cycle + "historically recovers" annotations.
//
// Root-cause diagnosis moved to src/lib/mrl-root-cause.ts (ordered engine).
//
// Reused conventions (unchanged):
//   MRL           = "deliverable" per makeDeliverablePredicate()
//   delivery date = timeWeGotReply || replyTime
//   billing cycle = monthly anniversary of Start Date (fallback Go Live Date)
//   threshold     = tier target from Client Tracker "Plan" (client-reports TARGETS)

import type { Lead } from "@/types/lead";
import { parseDate, makeDeliverablePredicate } from "@/lib/analytics";

export type PaceSeverity = "on_track" | "at_risk" | "critical";

// Tuning knobs — exported so any admin surface shows the real values.
export const GRACE_PERIOD_DAYS = 7;            // calendar days before we evaluate at all
export const ON_TRACK_MAX_BEHIND = 0.10;       // ≤10% behind expected pace → on_track
export const AT_RISK_MAX_BEHIND = 0.30;        // ≤30% behind AND recoverable → at_risk
export const HARD_CRITICAL_BIZ_DAYS_LEFT = 3;  // ≤3 biz days left + below threshold → critical
export const MAX_VELOCITY_LOOKBACK_DAYS = 28;  // window scanned for the best 7-day run

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ClientPaceEvaluation {
  clientTag: string;
  companyName: string;
  plan: string;
  threshold: number;
  cycleStart: string;          // ISO date (yyyy-mm-dd)
  cycleEnd: string;
  cycleLength: number;         // calendar days in this cycle (28–31)
  daysElapsed: number;         // calendar, day 1 = cycle start day
  daysRemaining: number;       // calendar
  bizDaysTotal: number;        // Mon–Fri days in the cycle
  bizDaysElapsed: number;
  bizDaysRemaining: number;
  actualMrls: number;
  expectedMrlsToDate: number;  // business-day-paced expectation
  pctBehind: number;           // 1 − actual/expected (0 = on pace, 0.4 = 40% behind)
  paceRatio: number;           // actual/expected (kept for continuity)
  velocity7d: number;          // CURRENT trailing-7d rate, MRLs per business day
  maxVelocity7d: number;       // BEST 7d rolling rate in lookback, MRLs per business day
  velocityDaily: number[];     // MRLs delivered per day, oldest→newest, last 7 days
  projectedTotal: number;      // actual + maxVelocity7d × bizDaysRemaining
  recoverable: boolean;        // projectedTotal ≥ threshold
  hardCriticalOverride: boolean;
  priorCycleActualAtSameDay: number | null;
  priorCycleTotal: number | null;
  isFirstCycle: boolean;
  historicallyRecovers: boolean;
  severity: PaceSeverity;
  inGracePeriod: boolean;
}

export interface EvaluateClientPaceInput {
  clientTag: string;
  companyName: string;
  plan: string;
  threshold: number;
  /** Billing anchor — client's Start Date, falling back to Go Live Date. */
  cycleAnchor: Date;
  leads: Lead[];
  now?: Date;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Mon–Fri days in [from, to). Day-level; ignores time-of-day + holidays. */
export function countBusinessDays(from: Date, to: Date): number {
  if (to <= from) return 0;
  let count = 0;
  const cur = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  while (cur < end) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

/** Monthly anniversary of `anchor` shifted by `months`, clamped for short months. */
function anniversary(anchor: Date, months: number): Date {
  const y = anchor.getFullYear();
  const m = anchor.getMonth() + months;
  const day = anchor.getDate();
  const lastDayOfTarget = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(day, lastDayOfTarget));
}

/** Latest cycle start ≤ now, as a whole number of months after the anchor. */
function currentCycleStart(anchor: Date, now: Date): { start: Date; index: number } {
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

  // Business-day pacing. Elapsed counts [cycleStart, tomorrow) so a delivery
  // expected "today" is included; remaining counts [tomorrow, cycleEnd).
  const startOfTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const bizDaysTotal = Math.max(1, countBusinessDays(cycleStart, cycleEnd));
  const bizDaysElapsed = Math.min(bizDaysTotal, countBusinessDays(cycleStart, startOfTomorrow));
  const bizDaysRemaining = Math.max(0, bizDaysTotal - bizDaysElapsed);

  // ── Deliverables ──────────────────────────────────────────────────────
  const isDeliverable = makeDeliverablePredicate(input.leads);
  const deliveredAt: Date[] = [];
  for (const lead of input.leads) {
    if (!isDeliverable(lead)) continue;
    const d = parseDate(lead.timeWeGotReply) || parseDate(lead.replyTime);
    if (d) deliveredAt.push(d);
  }

  const actualMrls = deliveredAt.filter((d) => d >= cycleStart && d <= now).length;

  // Daily counts, last 7 calendar days (oldest → newest) — sparkline data.
  const velocityDaily: number[] = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    velocityDaily.push(deliveredAt.filter((d) => d >= dayStart && d < dayEnd).length);
  }

  // Current trailing-7d rate per BUSINESS day.
  const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS);
  const last7Count = deliveredAt.filter((d) => d > sevenDaysAgo && d <= now).length;
  const bizDaysInLast7 = Math.max(1, countBusinessDays(sevenDaysAgo, startOfTomorrow));
  const velocity7d = last7Count / bizDaysInLast7;

  // MAX recent velocity: best 7-calendar-day window in the trailing lookback
  // (clamped to cycle start so a hot streak from a previous cycle can't make
  // this cycle look recoverable), per business day of that window.
  const lookbackStart = new Date(
    Math.max(cycleStart.getTime(), now.getTime() - MAX_VELOCITY_LOOKBACK_DAYS * DAY_MS),
  );
  let maxVelocity7d = velocity7d;
  for (
    let winStart = new Date(lookbackStart);
    winStart <= now;
    winStart = new Date(winStart.getTime() + DAY_MS)
  ) {
    const winEnd = new Date(Math.min(winStart.getTime() + 7 * DAY_MS, now.getTime()));
    const count = deliveredAt.filter((d) => d >= winStart && d <= winEnd).length;
    const biz = Math.max(1, countBusinessDays(winStart, new Date(winEnd.getTime() + DAY_MS)));
    const rate = count / biz;
    if (rate > maxVelocity7d) maxVelocity7d = rate;
  }

  // ── Prior cycle ───────────────────────────────────────────────────────
  const isFirstCycle = cycleIndex === 0;
  let priorCycleActualAtSameDay: number | null = null;
  let priorCycleTotal: number | null = null;
  if (!isFirstCycle) {
    const prevStart = anniversary(input.cycleAnchor, cycleIndex - 1);
    const prevSameDay = new Date(prevStart.getTime() + daysElapsed * DAY_MS);
    priorCycleActualAtSameDay = deliveredAt.filter((d) => d >= prevStart && d < prevSameDay).length;
    priorCycleTotal = deliveredAt.filter((d) => d >= prevStart && d < cycleStart).length;
  }
  // "Historically recovers": last cycle they were doing the same or worse at
  // this point in the cycle, yet still finished at/above threshold.
  const historicallyRecovers =
    priorCycleActualAtSameDay !== null &&
    priorCycleTotal !== null &&
    priorCycleActualAtSameDay <= actualMrls &&
    priorCycleTotal >= input.threshold;

  // ── Pace math ─────────────────────────────────────────────────────────
  const expectedMrlsToDate = (bizDaysElapsed / bizDaysTotal) * input.threshold;
  const paceRatio = expectedMrlsToDate > 0 ? actualMrls / expectedMrlsToDate : 1;
  const pctBehind = Math.max(0, 1 - paceRatio);
  const projectedTotal = Math.round(actualMrls + maxVelocity7d * bizDaysRemaining);
  const recoverable = projectedTotal >= input.threshold;

  const inGracePeriod = daysElapsed < GRACE_PERIOD_DAYS;
  const hardCriticalOverride =
    !inGracePeriod &&
    bizDaysRemaining <= HARD_CRITICAL_BIZ_DAYS_LEFT &&
    actualMrls < input.threshold;

  let severity: PaceSeverity;
  if (inGracePeriod) {
    severity = "on_track";
  } else if (hardCriticalOverride) {
    severity = "critical";
  } else if (pctBehind <= ON_TRACK_MAX_BEHIND) {
    severity = "on_track";
  } else if (pctBehind <= AT_RISK_MAX_BEHIND && recoverable) {
    severity = "at_risk";
  } else {
    severity = "critical";
  }

  return {
    clientTag: input.clientTag,
    companyName: input.companyName,
    plan: input.plan,
    threshold: input.threshold,
    cycleStart: isoDate(cycleStart),
    cycleEnd: isoDate(cycleEnd),
    cycleLength,
    daysElapsed,
    daysRemaining,
    bizDaysTotal,
    bizDaysElapsed,
    bizDaysRemaining,
    actualMrls,
    expectedMrlsToDate: Math.round(expectedMrlsToDate * 10) / 10,
    pctBehind: Math.round(pctBehind * 100) / 100,
    paceRatio: Math.round(paceRatio * 100) / 100,
    velocity7d: Math.round(velocity7d * 100) / 100,
    maxVelocity7d: Math.round(maxVelocity7d * 100) / 100,
    velocityDaily,
    projectedTotal,
    recoverable,
    hardCriticalOverride,
    priorCycleActualAtSameDay,
    priorCycleTotal,
    isFirstCycle,
    historicallyRecovers,
    severity,
    inGracePeriod,
  };
}
