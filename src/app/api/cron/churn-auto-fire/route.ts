import { NextResponse } from "next/server";
import { runAutoFireForOverdue, runRetryForFailed } from "@/lib/churn-offboarding";

// Long timeout — each overdue row triggers executeClientOffboarding which
// touches Bison (pause N campaigns + detach tag from M inboxes per instance).
export const maxDuration = 300;

// 9 AM PST cron: (1) auto-fire any pending row past its churn date, then
// (2) auto-retry previously-failed offboardings (up to 3 tries; after that a
// human force-retries via the Offboard button).
export async function GET() {
  try {
    const result = await runAutoFireForOverdue();
    const retry = await runRetryForFailed();
    console.log(
      `[cron/churn-auto-fire] fired=${result.fired.length} failed=${result.failed.length} recovered=${retry.recovered.length} stillFailing=${retry.stillFailing.length}`,
    );
    return NextResponse.json({
      fired: result.fired.length,
      failed: result.failed.length,
      recovered: retry.recovered.length,
      stillFailing: retry.stillFailing.length,
      details: { ...result, retry },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    console.error("[cron/churn-auto-fire]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
