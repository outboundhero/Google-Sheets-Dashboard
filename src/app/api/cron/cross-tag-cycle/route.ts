import { NextResponse } from "next/server";
import { runCrossTagCycle, getCrossTagCycleState } from "@/lib/replacement/cross-tag-worker";

export const maxDuration = 300;

// GET /api/cron/cross-tag-cycle — hourly worker behind Spencer's "run the
// wrong-campaign removal automatically every 72 hours". Advances the
// audit → remove → clear cycle in bounded slices; the 72h cadence lives in
// the Redis state. ?state=1 inspects without running; ?force=1 starts a new
// cycle immediately when idle. Kill switch: CROSS_TAG_AUTO_DISABLED=1.
export async function GET(request: Request) {
  try {
    const p = new URL(request.url).searchParams;
    if (p.get("state") === "1") {
      const s = await getCrossTagCycleState();
      return NextResponse.json(s ? { ...s, domains: s.domains.length } : { phase: "unstarted" });
    }
    return NextResponse.json(await runCrossTagCycle({ force: p.get("force") === "1" }));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
