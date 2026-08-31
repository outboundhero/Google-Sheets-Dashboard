// "Clients going live" forecast — READ-ONLY. Reads the Client Tracker sheet and
// surfaces which clients are scheduled to go live soon, bucketed around the
// upcoming 1st and 15th (the billing boundaries clients typically launch on).
// Gives lead time to buy + warm domains before a client needs inboxes.
import { getClientTrackerData } from "@/lib/google-sheets";
import { parseSheetDate } from "@/lib/churn-offboarding";
import { pstDateString } from "@/lib/date-utils";

export interface GoingLiveClient {
  clientAbbr: string;
  companyName: string;
  /** Bucketing date: START date (Spencer 2026-08-31 — "start dates on the 1st
   *  go to Group 2, on the 15th to Group 1"), falling back to go-live only
   *  when no start date exists. Was go-live-first, which put clients starting
   *  Sep 1 outside the 1st/15th buckets (all seven showed under 9/9). */
  date: string;                            // YYYY-MM-DD (startDate, else goLiveDate)
  daysUntil: number;                       // relative to today (PST)
  source: "goLiveDate" | "startDate";
  /** Readiness deadline: campaigns begin sending this day — domains must be
   *  warmed by it. Shown alongside, never used for bucketing. */
  goLiveDate: string | null;
  /** Spencer's standing rule from the START date: 1st → Group 2, 15th →
   *  Group 1, anything else → null (surface as unassigned, don't guess). */
  group: 1 | 2 | null;
  status: string;
}

export interface GoingLiveForecast {
  today: string;
  nextFirst: string;
  nextFifteenth: string;
  horizonDays: number;
  onNextFirst: GoingLiveClient[];
  onNextFifteenth: GoingLiveClient[];
  otherUpcoming: GoingLiveClient[];
  totalUpcoming: number;
}

/** Next calendar occurrence of `day` (1..28) that is today or later, as YYYY-MM-DD. */
function nextDayOfMonth(todayStr: string, day: number): string {
  const [y, m, d] = todayStr.split("-").map(Number);
  let year = y, month = m; // month is 1-based
  if (d > day) { month++; if (month > 12) { month = 1; year++; } }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function daysBetween(fromStr: string, toStr: string): number {
  const a = Date.parse(`${fromStr}T00:00:00Z`);
  const b = Date.parse(`${toStr}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export async function getGoingLiveForecast(opts: { horizonDays?: number } = {}): Promise<GoingLiveForecast> {
  const horizonDays = Math.max(1, opts.horizonDays ?? 45);
  const today = pstDateString(new Date());
  const nextFirst = nextDayOfMonth(today, 1);
  const nextFifteenth = nextDayOfMonth(today, 15);

  const rows = await getClientTrackerData();
  const upcoming: GoingLiveClient[] = [];
  for (const row of rows) {
    if (row.status?.trim().toLowerCase() === "churned") continue;
    const abbr = (row.clientAbbr || "").trim().toUpperCase();
    if (!abbr) continue;

    const go = parseSheetDate(row.goLiveDate);
    const start = parseSheetDate(row.startDate);
    const date = start ?? go; // start-first — the 1st/15th buckets are a START-date rule
    if (!date) continue;

    const daysUntil = daysBetween(today, date);
    if (daysUntil < 0 || daysUntil > horizonDays) continue; // only future within horizon

    const dayOfMonth = Number(date.slice(8, 10));
    upcoming.push({
      clientAbbr: abbr,
      companyName: row.companyName || abbr,
      date,
      daysUntil,
      source: start ? "startDate" : "goLiveDate",
      goLiveDate: go,
      group: dayOfMonth === 1 ? 2 : dayOfMonth === 15 ? 1 : null,
      status: row.status?.trim() || "",
    });
  }

  const sortFn = (a: GoingLiveClient, b: GoingLiveClient) => a.date.localeCompare(b.date) || a.clientAbbr.localeCompare(b.clientAbbr);
  const onNextFirst = upcoming.filter((c) => c.date === nextFirst).sort(sortFn);
  const onNextFifteenth = upcoming.filter((c) => c.date === nextFifteenth).sort(sortFn);
  const otherUpcoming = upcoming.filter((c) => c.date !== nextFirst && c.date !== nextFifteenth).sort(sortFn);

  return {
    today,
    nextFirst,
    nextFifteenth,
    horizonDays,
    onNextFirst,
    onNextFifteenth,
    otherUpcoming,
    totalUpcoming: upcoming.length,
  };
}
