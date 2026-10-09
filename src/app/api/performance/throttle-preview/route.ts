import { NextResponse } from "next/server";
import { buildThrottlePreview } from "@/lib/sending-mode/throttle-preview";

export const maxDuration = 120;

// GET /api/performance/throttle-preview — what the next daily auto-throttle
// pass would do and what it would cost. Read-only; works whether or not the
// pass is switched on (SENDING_MODE_THROTTLE_ENABLED).
export async function GET() {
  try {
    return NextResponse.json(await buildThrottlePreview());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
