// Churn blackout for Automatic Domain Replacement (Spencer 2026-08-06):
// "make sure it doesn't run if it's within five days of the client churn date
//  for any client tag this is true for."
//
// A client tag is blocked when its Client Tracker churn date is set and falls
// on/within the next CHURN_BLACKOUT_DAYS days — OR has already passed. No point
// buying/attaching fresh domains for a client that's about to (or did) churn.
//
// Churn dates are the same source the offboarding automation uses
// (getClientTrackerData → "Churn Date" column), so this stays in lockstep with
// churn-offboarding.ts.

import { getClientTrackerData } from "@/lib/google-sheets";
import { parseSheetDate } from "@/lib/churn-offboarding";
import { pstDateString } from "@/lib/date-utils";

// 7, not 5 — Spencer corrected himself mid-Loom (Jul-29 Part 2, 14:01: "I'm
// going to correct myself. Seven days before the churn date") and the written
// requirements doc pins it: block at exactly 7 days and closer.
export const CHURN_BLACKOUT_DAYS = 7;

export interface ChurnBlackout {
  clientTag: string;
  blocked: boolean;
  churnDate: string | null;   // YYYY-MM-DD or null when no churn date is set
  daysUntil: number | null;   // whole days from today (PST); negative = already churned
  reason: string | null;      // human-readable when blocked
}

// Whole-day difference between two YYYY-MM-DD strings (b - a), UTC-anchored so
// no timezone drift. Positive = b is in the future relative to a.
function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const ta = Date.UTC(ay, am - 1, ad);
  const tb = Date.UTC(by, bm - 1, bd);
  return Math.round((tb - ta) / 86_400_000);
}

/**
 * Returns the churn blackout status for a single client tag. Never throws for a
 * missing client — an unknown/never-churning tag comes back `blocked: false`.
 */
export async function getChurnBlackout(clientTag: string): Promise<ChurnBlackout> {
  const tag = clientTag.trim().toUpperCase();
  const today = pstDateString(new Date());

  let rows: Awaited<ReturnType<typeof getClientTrackerData>> = [];
  try {
    rows = await getClientTrackerData();
  } catch {
    // Fail OPEN on a data-fetch error — the guard is a safety net for the known
    // churn case, not a reason to block every replacement on a transient error.
    return { clientTag: tag, blocked: false, churnDate: null, daysUntil: null, reason: null };
  }

  const row = rows.find((r) => (r.clientAbbr || "").trim().toUpperCase() === tag);
  const churnDate = parseSheetDate(row?.churnDate);
  if (!churnDate) {
    return { clientTag: tag, blocked: false, churnDate: null, daysUntil: null, reason: null };
  }

  const daysUntil = daysBetween(today, churnDate);
  const blocked = daysUntil <= CHURN_BLACKOUT_DAYS;
  const reason = blocked
    ? daysUntil < 0
      ? `already churned (${churnDate})`
      : `churn in ${daysUntil} day${daysUntil === 1 ? "" : "s"} (${churnDate})`
    : null;

  return { clientTag: tag, blocked, churnDate, daysUntil, reason };
}
