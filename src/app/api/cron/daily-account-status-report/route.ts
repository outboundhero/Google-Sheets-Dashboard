import { NextResponse } from "next/server";
import { buildAccountStatusReport } from "@/app/api/account-status/route";

export const maxDuration = 60;

const PST_OFFSET_MS = 8 * 60 * 60 * 1000;
function todayPstDateString(): string {
  return new Date(Date.now() - PST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * GET /api/cron/daily-account-status-report
 *
 * Fired by Vercel cron (default schedule: 11:55 PM PST, see vercel.json).
 * Builds today's account-status report and POSTs it to the n8n webhook
 * configured via N8N_DAILY_REPORT_WEBHOOK_URL. n8n's Gmail node handles
 * the actual email send to the configured recipients.
 *
 * Also supports `?date=YYYY-MM-DD` for manual re-sends of past days
 * (admin can hit the URL manually).
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const date = searchParams.get("date") || todayPstDateString();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "Invalid date — expected YYYY-MM-DD" }, { status: 400 });
    }

    const report = await buildAccountStatusReport(date);

    const webhookUrl = process.env.N8N_DAILY_REPORT_WEBHOOK_URL;
    if (!webhookUrl) {
      console.warn("[cron/daily-report] N8N_DAILY_REPORT_WEBHOOK_URL not set — skipping send");
      return NextResponse.json({
        ok: false,
        sent: false,
        reason: "N8N_DAILY_REPORT_WEBHOOK_URL not configured",
        report,
      });
    }

    const t0 = Date.now();
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
    const ms = Date.now() - t0;

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[cron/daily-report] n8n webhook failed ${res.status} in ${ms}ms: ${text.slice(0, 300)}`);
      return NextResponse.json(
        { ok: false, sent: false, status: res.status, error: text.slice(0, 500) },
        { status: 502 },
      );
    }

    console.log(`[cron/daily-report] sent ${date} report to n8n in ${ms}ms — D=${report.totals.disconnected} R=${report.totals.reconnected} F=${report.totals.failed}`);
    return NextResponse.json({ ok: true, sent: true, date, totals: report.totals });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    console.error("[cron/daily-report] error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
