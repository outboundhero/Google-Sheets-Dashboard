import { NextResponse } from "next/server";
import { resolveInstances } from "@/lib/bison";
import { runConformTags } from "@/lib/conform-tags";

export const maxDuration = 300;

/**
 * POST /api/deliverability/conform-tags?instances=<csv>
 *
 * Thin wrapper around runConformTags() — the actual plan/apply logic lives in
 * src/lib/conform-tags.ts so the cron routes (see /api/cron/conform-tags-*)
 * can reuse it without going through HTTP.
 *
 * Body: { dryRun?: boolean, skipDisconnected?: boolean }
 *   - dryRun (default true): return plan without touching Bison
 *   - skipDisconnected (default true): ignore senders whose status looks
 *     disconnected / auth-failed
 *
 * See src/lib/conform-tags.ts for the full behavior + trade-offs.
 */
export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const instances = resolveInstances(searchParams);
    const body = await request.json().catch(() => ({}));
    const dryRun = body?.dryRun !== false;
    const skipDisconnected = body?.skipDisconnected !== false;

    const result = await runConformTags({ instances, dryRun, skipDisconnected });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
