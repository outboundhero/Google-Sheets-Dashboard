import { NextResponse } from "next/server";
import { sendDailyReplacementReport } from "@/lib/replacement/daily-report";

export const maxDuration = 120;

// GET /api/cron/replacement-daily-report — end-of-day "what replacement did
// today" → Slack (summary + threaded per-client breakdown). Scheduled daily at
// 5pm PST (see vercel.json). ?dry=1 returns the report WITHOUT posting;
// ?date=YYYY-MM-DD re-sends a past PST day.
export async function GET(request: Request) {
  try {
    const p = new URL(request.url).searchParams;
    const date = p.get("date") || undefined;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "Invalid date — expected YYYY-MM-DD" }, { status: 400 });
    }
    return NextResponse.json(await sendDailyReplacementReport({ date, dryRun: p.get("dry") === "1" }));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
