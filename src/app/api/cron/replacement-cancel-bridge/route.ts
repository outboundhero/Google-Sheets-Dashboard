import { NextResponse } from "next/server";
import { processReplacementCancellations } from "@/lib/replacement/cancel-bridge";

export const maxDuration = 120;

// GET /api/cron/replacement-cancel-bridge — hourly. Feeds due (5-day grace
// elapsed) replacement cancellations into the staged vendor-cancel queue.
// Stale backlog is held, re-assigned/skipped domains aborted — see
// lib/replacement/cancel-bridge.ts. ?dry=1 previews without writing.
export async function GET(request: Request) {
  try {
    const p = new URL(request.url).searchParams;
    return NextResponse.json(await processReplacementCancellations({ dryRun: p.get("dry") === "1" }));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
