import { getClientTrackerData } from "@/lib/google-sheets";
import { parseSheetDate } from "@/lib/churn-offboarding";
import { pstDateString } from "@/lib/date-utils";

// Go-live gate. Nothing automated may put a client's campaign into a sending
// state before the Go Live Date on the Client Tracker (Vicky 2026-09-23:
// "NEVER launch a campaign before its live date — always read the sheet").
// The tracker is the source of truth; a tag we cannot find, or a row with no
// Go Live Date, is treated as NOT cleared — the safe direction, since a
// client that has genuinely launched always has the date filled in.

export interface GoLiveInfo {
  /** Tracker Go Live Date as YYYY-MM-DD, null when blank/unparseable. */
  goLiveDate: string | null;
  /** True only when the date exists and is today or earlier (PST). */
  cleared: boolean;
  /** Why it is not cleared — for the audit line. */
  reason: string | null;
}

export type GoLiveMap = Map<string, GoLiveInfo>;

/** Go-live status per UPPERCASE client tag, read live from the Client Tracker. */
export async function loadGoLiveGate(today = pstDateString(new Date())): Promise<GoLiveMap> {
  const rows = await getClientTrackerData();
  const map: GoLiveMap = new Map();
  for (const r of rows) {
    const tag = (r.clientAbbr || "").trim().toUpperCase();
    if (!tag) continue;
    const goLiveDate = parseSheetDate(r.goLiveDate);
    if (!goLiveDate) {
      map.set(tag, { goLiveDate: null, cleared: false, reason: "no Go Live Date on the Client Tracker" });
      continue;
    }
    const cleared = goLiveDate <= today;
    map.set(tag, {
      goLiveDate,
      cleared,
      reason: cleared ? null : `go-live date ${goLiveDate} has not arrived yet`,
    });
  }
  return map;
}

/** Gate for one tag. Unknown tag = not cleared. */
export function goLiveCleared(tag: string, gate: GoLiveMap): GoLiveInfo {
  return gate.get(tag.trim().toUpperCase()) ?? {
    goLiveDate: null,
    cleared: false,
    reason: "client tag not found on the Client Tracker",
  };
}
