import { NextResponse } from "next/server";
import { enqueuePendingOffboardings } from "@/lib/churn-offboarding";

export const maxDuration = 30;

// Daily scan: pick up newly-churned clients from the Client Tracker sheet and
// insert pending rows into client_offboarding_actions. Idempotent — re-runs
// only insert rows that didn't already exist.
export async function GET() {
  try {
    const result = await enqueuePendingOffboardings();
    console.log(
      `[cron/churn-check] scanned=${result.scanned} created=${result.created} alreadyTracked=${result.alreadyTracked}`,
    );
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    console.error("[cron/churn-check]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
