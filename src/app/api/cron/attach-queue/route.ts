import { NextResponse } from "next/server";
import { processDueReattaches } from "@/lib/replacement/attach-queue";

export const maxDuration = 300;

// GET /api/cron/attach-queue — hourly worker for the deferred re-attach queue
// (8h waits for queued/launching campaigns + rate-limit leftovers).
export async function GET() {
  try {
    return NextResponse.json(await processDueReattaches());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
