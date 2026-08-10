import { NextResponse } from "next/server";
import { drainDuplicationOnce } from "@/lib/campaigns/duplication-drain";

// Cron backstop for the duplication queue — drains sets even when no browser is
// open. Loops until the queue is empty, single-flight-locked, or the run budget
// is hit. The FE loop handles the interactive case; this guarantees completion.
export const maxDuration = 300;

export async function GET() {
  const t0 = Date.now();
  let totalProcessed = 0;
  let last;
  for (let i = 0; i < 40 && Date.now() - t0 < 270_000; i++) {
    last = await drainDuplicationOnce();
    if (last.locked) break;               // another drainer active
    totalProcessed += last.processed;
    if (!last.more) break;                // queue drained
    if (last.processed === 0) break;      // only paused/blocked sets remain — nothing to do
  }
  return NextResponse.json({ totalProcessed, remaining: last?.remaining ?? null, durationMs: Date.now() - t0 });
}
