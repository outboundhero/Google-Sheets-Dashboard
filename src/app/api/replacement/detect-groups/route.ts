import { NextResponse } from "next/server";
import { getThresholdConfig } from "@/lib/replacement/threshold-groups-store";
import { runGroupDetection } from "@/lib/replacement/threshold-groups";

export const maxDuration = 60;

// GET /api/replacement/detect-groups — OBSERVE-ONLY preview using the SEGMENTED
// threshold groups. Runs the per-client-tag rule-sets over every domain and
// returns which WOULD flag, and which segment/group fired. Writes nothing,
// changes nothing, calls nothing. Returns {enabled:false} while groups are off.
export async function GET() {
  try {
    const cfg = await getThresholdConfig();
    if (!cfg.enabled) {
      return NextResponse.json({ enabled: false, scanned: 0, flaggedCount: 0, byInstance: {}, bySegment: {}, candidates: [] });
    }
    const { scanned, candidates } = await runGroupDetection(cfg);
    const byInstance: Record<string, number> = {};
    const bySegment: Record<string, number> = {};
    for (const c of candidates) {
      byInstance[c.instance] = (byInstance[c.instance] || 0) + 1;
      bySegment[c.segmentName] = (bySegment[c.segmentName] || 0) + 1;
    }
    return NextResponse.json({
      enabled: true,
      scanned,
      flaggedCount: candidates.length,
      byInstance,
      bySegment,
      candidates,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
