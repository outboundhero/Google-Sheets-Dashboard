// QL forecast for one client's current billing period — Nick + Spencer's
// Performance v2 (2026-10-14, answers 2026-10-16), kept separate from the MRL
// pacing engine (src/lib/mrl-pace.ts):
//
//   MRLs            Meeting-Ready leads only (Current Lead Category). "Lead
//                   Not Received" still counts as delivered.
//   reviewed        Quality Lead / Not a Quality Lead / Duplicate (a duplicate
//                   is a bad lead, counted once). Blank, Undetermined and
//                   anything unrecognised are pending; Lead Not Received is
//                   neither — it says nothing about quality.
//   actual rate     QLs ÷ reviewed, MRLs delivered in the last rateDays (30)
//   blended rate    (QLs + 4) ÷ (reviewed + 10) — drives the forecast, so a
//                   client with a handful of reviews doesn't swing to 0% or 100%
//   MRL pace        MRLs a day over the last mrlPaceDays (14)
//   projected       confirmed QLs + blended × pending MRLs this period
//                   + blended × MRL pace × days remaining
//   MRLs needed     guarantee ÷ blended rate
//
//   Critical       projected in the 100%-credit band, or projected below the
//                  guarantee with ≤ turboWindowDays left (a Turbo window no
//                  longer fits)
//   At Risk        projected below the guarantee with more days left than that
//   Below Target   projected meets the guarantee but not the operational target
//   On Track       projected meets the operational target (8 / 16 / 31)
//   Overperforming the auto-throttle would slow it down: forecast ≥ 150% of the
//                  guarantee, still at/above the target if throttled, enough
//                  data (≥ 10 reviewed MRLs in the rate window, ≥ 3 confirmed
//                  QLs, ≥ 7 days into the period), statuses being filled
//   new_client     days 1–newClientDays (19) from the client's Start Date: still
//                  tracked and forecast, never At Risk / Critical / Below
//                  Target / No status data. Overperforming still shows, so an
//                  over-delivering new client can be throttled (Nick 2026-10-14)
//
// Clients that can't be judged get the reason instead (Nick 2026-10-14, #8):
//   sync_error         the client's lead sheet hasn't synced in SYNC_STALE_DAYS
//   no_mrls            no Meeting-Ready leads this period, past the first week
//   new_period         first NEW_PERIOD_DAYS of the period, < MIN_MRLS leads
//   awaiting_reporting the client isn't filling the Status column (see below);
//                      lastStatusAt says how far their marking has got
//   insufficient_data  < MIN_MRLS leads this period — too few to forecast
//
// Counts and the forecast are live — pending leads are in the forecast at the
// client's rate, so a blank mid-week Status no longer reads as behind. The
// awaiting-reporting check still goes by the last Friday 5 PM PST, when the
// team has filled the week's statuses (Spencer 2026-10-10). Pace (QLs at the
// cut-off against a straight line) is kept for the window log only.
//
// Billing period = monthly anniversary of the Client Tracker Start Date
// (fallback Go Live), the same anchor MRL pacing uses. A lead's date is its
// delivery date (timeWeGotReply || replyTime) — the sheets don't record when a
// status was filled in.
import type { Lead } from "@/types/lead";
import { parseDate } from "@/lib/analytics";
import { anniversary, currentCycleStart } from "@/lib/mrl-pace";
import { isQualityLead } from "@/lib/cron/client-reports";
import type { SendingModeSettings } from "./config";

export type QlPaceStatus =
  | "new_client" | "on_track" | "below_target" | "at_risk" | "critical" | "overperforming"
  | "sync_error" | "no_mrls" | "new_period" | "awaiting_reporting" | "insufficient_data";

export interface QlPace {
  guarantee: number;
  /** Operational target — what we aim to deliver (8 / 16 / 31). */
  target: number;
  cycleStart: string;      // yyyy-mm-dd
  cycleEnd: string;
  cycleLength: number;     // calendar days
  daysElapsed: number;     // day 1 = cycle start day
  daysRemaining: number;
  /** MRLs delivered this period, and how many still have no verdict. */
  mrlsDelivered: number;
  mrlsPending: number;
  /** Confirmed QLs this period. */
  qlsDelivered: number;
  /** Last rateDays: QLs, NQLs, duplicates among reviewed MRLs. */
  qls30d: number;
  nqls30d: number;
  dups30d: number;
  actualRate: number | null;   // null with nothing reviewed
  blendedRate: number;
  mrlPace: number;             // MRLs a day, last mrlPaceDays
  mrlsNeeded: number | null;
  projected: number;
  /** Pace = QLs to the Friday cut-off ÷ a straight line to the guarantee. */
  expectedToDate: number;
  pace: number | null;     // null while expected is 0 — treated as on pace
  status: QlPaceStatus;
  /** Delivery date of the newest lead with a Status (yyyy-mm-dd) — how far
   *  the client's marking has got. */
  lastStatusAt: string | null;
  /** The Friday 5 PM PST cut-off pace and the no-data check are counted to. */
  judgedAt: string;
  /** MRLs before the cut-off this period, and how many have no Status. */
  repliesToDate: number;
  blankStatusToDate: number;
}

const DAY_MS = 86_400_000;
const PST_MS = 8 * 3_600_000; // UTC-8, no DST — same convention as date-utils
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

/** Most recent Friday 5 PM PST at or before `now`. */
export function lastStatusCutoff(now = new Date()): Date {
  const pstNow = new Date(now.getTime() - PST_MS); // PST wall clock, read via UTC getters
  const d = new Date(Date.UTC(pstNow.getUTCFullYear(), pstNow.getUTCMonth(), pstNow.getUTCDate(), 17));
  while (d.getUTCDay() !== 5 || d.getTime() > pstNow.getTime()) d.setUTCDate(d.getUTCDate() - 1);
  return new Date(d.getTime() + PST_MS);
}

// What an assigned account normally sends (limit-policy ASSIGNED_LIMIT) — the
// fallback for the under-target check when real capacity is unknown.
export const NORMAL_DAILY_LIMIT = 5;

/**
 * Projected QLs at the end of the period if the client sends only `keepRatio`
 * of today's volume from now on: confirmed QLs and the leads already delivered
 * stay; only the leads still to come (rate × MRL pace × days left) shrink with
 * sending. Used for "never throttle a client under target" (Vicky 2026-10-09 —
 * the first preview had SBTB going 16 → ~7, and the release rule would only
 * notice after the QLs were lost). Target = the operational target since v2.
 */
export function projectedIfThrottled(
  r: Pick<QlPace, "projected" | "blendedRate" | "mrlPace" | "daysRemaining">,
  keepRatio: number,
): number {
  const toCome = r.blendedRate * r.mrlPace * r.daysRemaining;
  return Math.round((r.projected - toCome * (1 - keepRatio)) * 10) / 10;
}

/** Operational target for a QL guarantee (Nick 2026-10-14: 5 → 8, 10 → 16,
 *  20 → 31). Anything else gets the same ~55% headroom. */
export function operationalTarget(guarantee: number): number {
  const known: Record<number, number> = { 5: 8, 10: 16, 20: 31 };
  return known[guarantee] ?? Math.ceil(guarantee * 1.55);
}

type Verdict = "ql" | "nql" | "dup" | "not_received" | "pending";

function verdict(lead: Lead): Verdict {
  if (isQualityLead(lead)) return "ql";
  const s = String(lead.status || "").toLowerCase();
  if (/duplicat|redundant/.test(s)) return "dup";
  if (s.includes("not a quality lead")) return "nql";
  if (s.includes("lead not received")) return "not_received";
  return "pending";
}

// "Awaiting Client Reporting": over half of this period's MRLs (min 3) still
// have no Status after the Friday cut-off, or the client has 20+ MRLs and has
// never had a single one marked (BAJFI, OH, SC… on 2026-10-10). Such a client
// isn't behind — we just can't see its QLs — so it is never Critical and never
// throttled.
const NO_DATA_MIN_REPLIES = 3;
const NO_DATA_BLANK_SHARE = 0.5;
const NEVER_MARKED_MIN_LEADS = 20;
const SYNC_STALE_DAYS = 2;     // the lead sync runs hourly
const NEW_PERIOD_DAYS = 7;
const MIN_MRLS = 3;
const hasStatus = (l: Lead) => String(l.status || "").trim() !== "";

/** The client's Meeting-Ready leads, each record once. A client whose sheet
 *  never fills the category counts every lead (same fallback as analytics). */
function meetingReadyLeads(leads: Lead[]): Lead[] {
  const usesCategory = leads.some((l) => String(l.currentCategory || "").trim() !== "");
  const seen = new Set<string>();
  const out: Lead[] = [];
  for (const l of leads) {
    if (usesCategory && !String(l.currentCategory || "").toLowerCase().includes("meeting")) continue;
    const email = String(l.email || "").trim().toLowerCase();
    if (email) {
      const key = `${email}|${l.timeWeGotReply || l.replyTime}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(l);
  }
  return out;
}

export function evaluateQlPace(input: {
  guarantee: number;
  cycleAnchor: Date;
  leads: Lead[];
  settings: SendingModeSettings;
  /** When the client's lead sheet last synced (the stalest of its sheets). */
  syncedAt?: string | null;
  now?: Date;
}): QlPace {
  const now = input.now ?? new Date();
  const s = input.settings;
  const target = operationalTarget(input.guarantee);
  const { start: cycleStart, index } = currentCycleStart(input.cycleAnchor, now);
  const cycleEnd = anniversary(input.cycleAnchor, index + 1);
  const cycleLength = Math.max(1, Math.round((cycleEnd.getTime() - cycleStart.getTime()) / DAY_MS));
  const daysElapsed = Math.min(cycleLength, Math.floor((now.getTime() - cycleStart.getTime()) / DAY_MS) + 1);
  const daysRemaining = Math.max(0, cycleLength - daysElapsed);

  const cutoff = lastStatusCutoff(now);
  const rateFrom = now.getTime() - s.rateDays * DAY_MS;
  const paceFrom = now.getTime() - s.mrlPaceDays * DAY_MS;

  const mrls = meetingReadyLeads(input.leads);
  let mrlsDelivered = 0, mrlsPending = 0, qlsDelivered = 0;
  let qls30d = 0, nqls30d = 0, dups30d = 0, paceMrls = 0;
  let qlsAtCutoff = 0, repliesToDate = 0, blankStatusToDate = 0, everMarked = 0;
  let lastStatus: Date | null = null;
  for (const lead of mrls) {
    const v = verdict(lead);
    if (v === "ql") everMarked++;
    const d = parseDate(lead.timeWeGotReply) || parseDate(lead.replyTime);
    if (!d || d > now) continue;
    if (hasStatus(lead) && (!lastStatus || d > lastStatus)) lastStatus = d;
    const t = d.getTime();
    if (t >= rateFrom) {
      if (v === "ql") qls30d++;
      else if (v === "nql") nqls30d++;
      else if (v === "dup") dups30d++;
    }
    if (t >= paceFrom) paceMrls++;
    if (d < cycleStart) continue;
    mrlsDelivered++;
    if (v === "ql") qlsDelivered++;
    if (v === "pending") mrlsPending++;
    if (d <= cutoff) {
      repliesToDate++;
      if (!hasStatus(lead)) blankStatusToDate++;
      if (v === "ql") qlsAtCutoff++;
    }
  }
  const noData =
    (repliesToDate >= NO_DATA_MIN_REPLIES && blankStatusToDate / repliesToDate > NO_DATA_BLANK_SHARE)
    || (everMarked === 0 && mrls.length >= NEVER_MARKED_MIN_LEADS && !mrls.some(hasStatus));

  const reviewed = qls30d + nqls30d + dups30d;
  const actualRate = reviewed > 0 ? qls30d / reviewed : null;
  const blendedRate = (qls30d + s.blendPriorQls) / Math.max(1, reviewed + s.blendPriorLeads);
  // A client younger than the pace window is averaged over the days it has had.
  const daysSinceStart = Math.floor((now.getTime() - input.cycleAnchor.getTime()) / DAY_MS) + 1;
  const mrlPace = paceMrls / Math.max(1, Math.min(s.mrlPaceDays, daysSinceStart));
  const projected = qlsDelivered + blendedRate * mrlsPending + blendedRate * mrlPace * daysRemaining;

  // Pace, at the Friday cut-off. No pace until the cut-off is minPaceDays into
  // the period.
  const cutoffDays = cutoff < cycleStart
    ? 0
    : Math.min(cycleLength, Math.floor((cutoff.getTime() - cycleStart.getTime()) / DAY_MS) + 1);
  const expectedToDate = input.guarantee * (cutoffDays / cycleLength);
  const pace = expectedToDate > 0 && cutoffDays >= s.minPaceDays ? qlsAtCutoff / expectedToDate : null;
  const newClient = daysSinceStart <= s.newClientDays;
  const syncStale = !!input.syncedAt && now.getTime() - new Date(input.syncedAt).getTime() > SYNC_STALE_DAYS * DAY_MS;

  const throttleReady = !noData
    && projected >= input.guarantee * s.throttleAtGuarantee
    && reviewed >= s.throttleMinReviewed
    && qlsDelivered >= s.throttleMinQls
    && daysElapsed >= s.throttleMinDays
    && projectedIfThrottled({ projected, blendedRate, mrlPace, daysRemaining }, s.throttleDailyLimit / NORMAL_DAILY_LIMIT) >= target;

  let status: QlPaceStatus;
  if (syncStale) status = "sync_error";
  else if (throttleReady) status = "overperforming";
  else if (newClient) status = "new_client";
  else if (mrlsDelivered === 0) status = daysElapsed <= NEW_PERIOD_DAYS ? "new_period" : "no_mrls";
  else if (daysElapsed <= NEW_PERIOD_DAYS && mrlsDelivered < MIN_MRLS) status = "new_period";
  else if (noData) status = "awaiting_reporting";
  else if (mrlsDelivered < MIN_MRLS) status = "insufficient_data";
  else if (projected <= input.guarantee * s.fullCreditFraction) status = "critical";
  else if (projected < input.guarantee && daysRemaining <= s.turboWindowDays) status = "critical";
  else if (projected < input.guarantee) status = "at_risk";
  else if (projected < target) status = "below_target";
  else status = "on_track";

  return {
    guarantee: input.guarantee,
    target,
    cycleStart: isoDate(cycleStart),
    cycleEnd: isoDate(cycleEnd),
    cycleLength,
    daysElapsed,
    daysRemaining,
    mrlsDelivered,
    mrlsPending,
    qlsDelivered,
    qls30d,
    nqls30d,
    dups30d,
    actualRate: actualRate === null ? null : round(actualRate, 3),
    blendedRate: round(blendedRate, 3),
    mrlPace: round(mrlPace, 2),
    mrlsNeeded: blendedRate > 0 ? Math.ceil(input.guarantee / blendedRate) : null,
    projected: round(projected, 1),
    expectedToDate: round(expectedToDate, 1),
    pace: pace === null ? null : round(pace, 2),
    status,
    lastStatusAt: lastStatus ? isoDate(lastStatus) : null,
    judgedAt: cutoff.toISOString(),
    repliesToDate,
    blankStatusToDate,
  };
}
