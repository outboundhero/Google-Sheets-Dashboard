import { NextResponse } from "next/server";
import { processDueCancellations } from "@/lib/deliverability/scheduled-cancellations";

export const maxDuration = 300;

// GET /api/cron/fire-scheduled-cancellations — advances the staged vendor-cancel
// queue: cancels domains whose 3-day buffer has elapsed, then (after a 10-min
// gap) deletes their sender accounts from Bison. Runs every 15 min.
export async function GET() {
  try {
    return NextResponse.json(await processDueCancellations());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
