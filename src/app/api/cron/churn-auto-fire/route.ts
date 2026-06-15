import { NextResponse } from "next/server";
import { runAutoFireForOverdue } from "@/lib/churn-offboarding";

// Long timeout — each overdue row triggers executeClientOffboarding which
// touches Bison (pause N campaigns + detach tag from M inboxes per instance).
export const maxDuration = 300;

// 9 AM PST cron: any pending row whose churn_date < today gets auto-executed.
export async function GET() {
  try {
    const result = await runAutoFireForOverdue();
    console.log(
      `[cron/churn-auto-fire] fired=${result.fired.length} failed=${result.failed.length}`,
    );
    return NextResponse.json({
      fired: result.fired.length,
      failed: result.failed.length,
      details: result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    console.error("[cron/churn-auto-fire]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
