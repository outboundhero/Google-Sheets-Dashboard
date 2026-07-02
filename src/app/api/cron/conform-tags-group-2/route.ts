import { NextResponse } from "next/server";
import { instancesInGroup } from "@/lib/bison-instances";
import { runConformTags } from "@/lib/conform-tags";

export const maxDuration = 300;

/**
 * GET /api/cron/conform-tags-group-2
 *
 * Twice-daily cron that runs Conform Tags apply for every instance in
 * Bison Group 2 (facilityreach + outboundclean). See
 * src/lib/conform-tags.ts for the full plan/apply logic.
 */
export async function GET() {
  const t0 = Date.now();
  const instances = instancesInGroup(2).map((i) => i.slug);
  try {
    const result = await runConformTags({
      instances,
      dryRun: false,
      skipDisconnected: true,
    });
    const durationMs = Date.now() - t0;
    if (result.dryRun) {
      return NextResponse.json({ ok: true, durationMs, unexpected: "dryRun result" });
    }
    console.log(
      `[cron/conform-tags:group-2] applied=${result.applied} failed=${result.failed} senders=${result.appliedSenders.length} duration=${durationMs}ms`,
    );
    return NextResponse.json({
      ok: true,
      group: 2,
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
    console.error(`[cron/conform-tags:group-2]`, message);
    return NextResponse.json({ error: message, group: 2 }, { status: 500 });
  }
}
