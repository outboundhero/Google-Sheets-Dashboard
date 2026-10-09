// QL pace for one client's current billing period — the maths from Nick's
// Performance & Turbo Mode spec, kept separate from the MRL pacing engine
// (src/lib/mrl-pace.ts) because the spec counts QLs on CALENDAR days:
//
//   expected by today = guarantee × (days elapsed ÷ days in period)
//   pace              = delivered ÷ expected
//   projected         = delivered ÷ days elapsed × days in period
//
//   Critical       projected in the 100%-credit band, or projected below the
//                  guarantee with ≤ turboWindowDays left (a Turbo window no
//                  longer fits)
//   At Risk        projected below the guarantee with more days left than that
//   On Track       projected meets the guarantee
//   Overperforming pace ≥ throttleOnPace (125%)
//   grace          first graceDays of the period — nothing is flagged
//   no_data        the team isn't filling the Status column for this client,
//                  so its QLs can't be counted (see below)
//
// Judged as of the last Friday 5 PM PST, not live. Spencer 2026-10-10: the
// team fills the lead sheets' Status column by Friday 5 PM each week (~75% of
// clients; the rest every 2-3 weeks or never). Mid-week most of the week's
// replies have no status yet, so a live count reads far behind (52 of 79
// clients showed Critical on a Friday afternoon, 32 of them only because
// Status was blank). QLs and "expected" are counted up to that cut-off; days
// remaining stay live, since that's what decides whether Turbo still fits.
//
// Billing period = monthly anniversary of the Client Tracker Start Date
// (fallback Go Live), the same anchor MRL pacing uses. QL = status has a
// "Quality Lead" part (incl. "Quality Lead (Appointment …)") and the lead's
// delivery date (timeWeGotReply || replyTime) falls inside the period.
import type { Lead } from "@/types/lead";
import { parseDate } from "@/lib/analytics";
import { anniversary, currentCycleStart } from "@/lib/mrl-pace";
import { isQualityLead } from "@/lib/cron/client-reports";
import type { SendingModeSettings } from "./config";

export type QlPaceStatus = "grace" | "on_track" | "at_risk" | "critical" | "overperforming" | "no_data";

export interface QlPace {
  guarantee: number;
  cycleStart: string;      // yyyy-mm-dd
  cycleEnd: string;
  cycleLength: number;     // calendar days
  daysElapsed: number;     // day 1 = cycle start day
  daysRemaining: number;
  qlsDelivered: number;
  expectedToDate: number;
  pace: number | null;     // null while expected is 0 (day 0) — treated as on pace
  projected: number;
  status: QlPaceStatus;
  /** The Friday 5 PM PST cut-off the QL numbers are counted up to. */
  judgedAt: string;
  /** Replies before the cut-off this period, and how many have no Status. */
  repliesToDate: number;
  blankStatusToDate: number;
}

const DAY_MS = 86_400_000;
const PST_MS = 8 * 3_600_000; // UTC-8, no DST — same convention as date-utils
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** Most recent Friday 5 PM PST at or before `now`. */
export function lastStatusCutoff(now = new Date()): Date {
  const pstNow = new Date(now.getTime() - PST_MS); // PST wall clock, read via UTC getters
  const d = new Date(Date.UTC(pstNow.getUTCFullYear(), pstNow.getUTCMonth(), pstNow.getUTCDate(), 17));
  while (d.getUTCDay() !== 5 || d.getTime() > pstNow.getTime()) d.setUTCDate(d.getUTCDate() - 1);
  return new Date(d.getTime() + PST_MS);
}

// "No status data": over half of this period's replies (min 3) still have no
// Status after the Friday cut-off, or the client has 20+ leads and has never
// had a single one marked (BAJFI, OH, SC… on 2026-10-10). Such a client isn't
// behind — we just can't see its QLs — so it is never Critical and never
// throttled.
const NO_DATA_MIN_REPLIES = 3;
const NO_DATA_BLANK_SHARE = 0.5;
const NEVER_MARKED_MIN_LEADS = 20;
const hasStatus = (l: Lead) => String(l.status || "").trim() !== "";

export function evaluateQlPace(input: {
  guarantee: number;
  cycleAnchor: Date;
  leads: Lead[];
  settings: SendingModeSettings;
  now?: Date;
}): QlPace {
  const now = input.now ?? new Date();
  const { start: cycleStart, index } = currentCycleStart(input.cycleAnchor, now);
  const cycleEnd = anniversary(input.cycleAnchor, index + 1);
  const cycleLength = Math.max(1, Math.round((cycleEnd.getTime() - cycleStart.getTime()) / DAY_MS));
  const daysElapsedLive = Math.min(cycleLength, Math.floor((now.getTime() - cycleStart.getTime()) / DAY_MS) + 1);
  const daysRemaining = Math.max(0, cycleLength - daysElapsedLive);

  // Counted up to the Friday cut-off. No Friday yet this period → day 0, which
  // falls in the grace band below.
  const cutoff = lastStatusCutoff(now);
  const daysElapsed = cutoff < cycleStart
    ? 0
    : Math.min(cycleLength, Math.floor((cutoff.getTime() - cycleStart.getTime()) / DAY_MS) + 1);

  let qlsDelivered = 0, repliesToDate = 0, blankStatusToDate = 0, everMarked = 0;
  for (const lead of input.leads) {
    if (isQualityLead(lead)) everMarked++;
    const d = parseDate(lead.timeWeGotReply) || parseDate(lead.replyTime);
    if (!d || d < cycleStart || d > cutoff) continue;
    repliesToDate++;
    if (!hasStatus(lead)) blankStatusToDate++;
    if (isQualityLead(lead)) qlsDelivered++;
  }
  const noData =
    (repliesToDate >= NO_DATA_MIN_REPLIES && blankStatusToDate / repliesToDate > NO_DATA_BLANK_SHARE)
    || (everMarked === 0 && input.leads.length >= NEVER_MARKED_MIN_LEADS && !input.leads.some(hasStatus));

  const expectedToDate = input.guarantee * (daysElapsed / cycleLength);
  const pace = expectedToDate > 0 ? qlsDelivered / expectedToDate : null;
  const projected = Math.round((qlsDelivered / Math.max(1, daysElapsed)) * cycleLength);

  const s = input.settings;
  let status: QlPaceStatus;
  if (daysElapsed <= s.graceDays) status = "grace";
  else if (noData) status = "no_data";
  else if (pace !== null && pace >= s.throttleOnPace) status = "overperforming";
  else if (projected <= input.guarantee * s.fullCreditFraction) status = "critical";
  else if (projected < input.guarantee && daysRemaining <= s.turboWindowDays) status = "critical";
  else if (projected < input.guarantee) status = "at_risk";
  else status = "on_track";

  return {
    guarantee: input.guarantee,
    cycleStart: isoDate(cycleStart),
    cycleEnd: isoDate(cycleEnd),
    cycleLength,
    daysElapsed,
    daysRemaining,
    qlsDelivered,
    expectedToDate: Math.round(expectedToDate * 10) / 10,
    pace: pace === null ? null : Math.round(pace * 100) / 100,
    projected,
    status,
    judgedAt: cutoff.toISOString(),
    repliesToDate,
    blankStatusToDate,
  };
}
