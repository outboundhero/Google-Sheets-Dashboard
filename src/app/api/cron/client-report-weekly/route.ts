import { NextResponse } from "next/server";
import { buildWeeklyReport, sendClientReport } from "@/lib/cron/client-reports";
import { pstDateString } from "@/lib/date-utils";

export const maxDuration = 300;

// Weekly client performance recap + underperformance flags. Scheduled Friday
// 12:00 PM PT (see vercel.json). `?date=` sets the window end; `?preview=1`
// builds without sending.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const endDate = searchParams.get("date") || pstDateString(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return NextResponse.json({ error: "Invalid date — expected YYYY-MM-DD" }, { status: 400 });
    }

    const report = await buildWeeklyReport(endDate);
    if (searchParams.get("preview")) {
      return NextResponse.json({ preview: true, ...report });
    }
    const send = await sendClientReport({ type: "weekly", ...report });
    return NextResponse.json({ ok: true, endDate, flaggedCount: report.flaggedCount, ...send });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    console.error("[cron/client-report-weekly]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
