import { NextResponse } from "next/server";
import { runReconnectWorker } from "@/lib/reconnect-worker";

// Vercel cron cap for this route. We give the worker a 55s soft deadline
// inside runReconnectWorker so the last row can finish + write results
// before Vercel guillotines the invocation.
export const maxDuration = 60;

/**
 * GET /api/cron/reconnect-worker
 *
 * Drains pending_reconnect_work. For each row: conform the sender's tags
 * against its domain's wanted-tag set and attach the sender to every
 * campaign matching one of its client tags (active/launching/queued/paused).
 * See src/lib/reconnect-worker.ts for the full logic.
 *
 * Scheduled every 5 minutes (vercel.json). Middleware exempts /api/cron/*.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = Math.max(1, Math.min(500, parseInt(searchParams.get("limit") || "200", 10)));
  try {
    const result = await runReconnectWorker({ limit });
    console.log(
      `[cron/reconnect-worker] processed=${result.processed} ok=${result.succeeded} retry=${result.failed} fatal=${result.fatal} tags=${result.totalTagsAttached} campaigns=${result.totalCampaignsAttached} duration=${result.durationMs}ms`,
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "reconnect worker failed";
    console.error("[cron/reconnect-worker]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
