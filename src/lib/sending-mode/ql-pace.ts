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

export type QlPaceStatus = "grace" | "on_track" | "at_risk" | "critical" | "overperforming";

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
}

const DAY_MS = 86_400_000;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

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
  const daysElapsed = Math.min(cycleLength, Math.floor((now.getTime() - cycleStart.getTime()) / DAY_MS) + 1);
  const daysRemaining = Math.max(0, cycleLength - daysElapsed);

  let qlsDelivered = 0;
  for (const lead of input.leads) {
    if (!isQualityLead(lead)) continue;
    const d = parseDate(lead.timeWeGotReply) || parseDate(lead.replyTime);
    if (d && d >= cycleStart && d <= now) qlsDelivered++;
  }

  const expectedToDate = input.guarantee * (daysElapsed / cycleLength);
  const pace = expectedToDate > 0 ? qlsDelivered / expectedToDate : null;
  const projected = Math.round((qlsDelivered / Math.max(1, daysElapsed)) * cycleLength);

  const s = input.settings;
  let status: QlPaceStatus;
  if (daysElapsed <= s.graceDays) status = "grace";
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
  };
}
