import { NextResponse } from "next/server";
import { buildDailyReport, sendClientReport } from "@/lib/cron/client-reports";
import { pstDateString } from "@/lib/date-utils";

// 800s (same ceiling auto-runner already uses). The read pacing alone spends
// ~165s of it; a run that hits Google's per-minute quota then backs off 20s a
// sheet, which could blow a 300s budget and kill the whole report. Headroom is
// cheaper than a missing report.
export const maxDuration = 800;

// Daily client meeting-ready report. Scheduled 4:30 PM PT (see vercel.json).
// `?date=YYYY-MM-DD` allows manual re-sends. `?preview=1` builds without sending.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const date = searchParams.get("date") || pstDateString(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "Invalid date — expected YYYY-MM-DD" }, { status: 400 });
    }

    const report = await buildDailyReport(date);
    if (searchParams.get("preview")) {
      return NextResponse.json({ preview: true, ...report });
    }
    const send = await sendClientReport({ type: "daily", ...report });
    return NextResponse.json({ ok: true, date, ...send });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    console.error("[cron/client-report-daily]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
