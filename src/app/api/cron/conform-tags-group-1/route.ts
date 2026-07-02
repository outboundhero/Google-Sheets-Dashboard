import { NextResponse } from "next/server";
import { instancesInGroup } from "@/lib/bison-instances";
import { runConformTags } from "@/lib/conform-tags";

// Vercel cron ceiling is 300s. The apply phase can touch many tags per
// instance (each does its own /tags/attach-to-sender-emails batches of 100),
// so we cap generously.
export const maxDuration = 300;

/**
 * GET /api/cron/conform-tags-group-1
 *
 * Twice-daily cron that runs Conform Tags apply for every instance in
 * Bison Group 1 (outboundhero + cleaningoutbound). Pushes each domain's
 * deliverability_domains.tags down to every sender on that domain that's
 * missing them.
 *
 * Middleware exempts /api/cron/* from session auth. See
 * src/lib/conform-tags.ts for the full plan/apply logic.
 */
export async function GET() {
  const t0 = Date.now();
  const instances = instancesInGroup(1).map((i) => i.slug);
  try {
    const result = await runConformTags({
      instances,
      dryRun: false,
      skipDisconnected: true,
    });
    const durationMs = Date.now() - t0;
    if (result.dryRun) {
      // Shouldn't happen — dryRun: false above — but the type union forces us
      // to guard.
      return NextResponse.json({ ok: true, durationMs, unexpected: "dryRun result" });
    }
    console.log(
      `[cron/conform-tags:group-1] applied=${result.applied} failed=${result.failed} senders=${result.appliedSenders.length} duration=${durationMs}ms`,
    );
    return NextResponse.json({
      ok: true,
      group: 1,
      instances,
      applied: result.applied,
      failed: result.failed,
      sendersTagged: result.appliedSenders.length,
      failures: result.failures,
      perInstance: result.perInstance,
      batchId: result.batchId,
      durationMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "conform-tags cron failed";
    console.error(`[cron/conform-tags:group-1]`, message);
    return NextResponse.json({ error: message, group: 1 }, { status: 500 });
  }
}
