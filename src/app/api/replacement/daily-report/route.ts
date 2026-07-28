import { NextResponse } from "next/server";
import { buildDailyReplacementReport } from "@/lib/replacement/daily-report";

export const maxDuration = 120;

// GET /api/replacement/daily-report?date=YYYY-MM-DD — the end-of-day report for
// the dashboard (defaults to today, PST). Read-only; no Slack. Admin-only via
// middleware.
export async function GET(request: Request) {
  try {
    const date = new URL(request.url).searchParams.get("date") || undefined;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "Invalid date — expected YYYY-MM-DD" }, { status: 400 });
    }
    return NextResponse.json(await buildDailyReplacementReport(date));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
