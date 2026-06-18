import { NextResponse } from "next/server";
import { getSettings } from "@/lib/replacement/store";
import { runDetection } from "@/lib/replacement/detect";

export const maxDuration = 60;

// GET /api/replacement/detect — OBSERVE-ONLY preview. Runs the guardrails over
// every domain and returns which WOULD be flagged as burnt. Writes nothing,
// changes nothing, makes no external calls. Admin-only via middleware.
export async function GET() {
  try {
    const cfg = await getSettings();
    const { scanned, candidates } = await runDetection(cfg);
    const byInstance: Record<string, number> = {};
    for (const c of candidates) byInstance[c.instance] = (byInstance[c.instance] || 0) + 1;
    return NextResponse.json({
      mode: cfg.mode,
      settings: cfg,
      scanned,
      flaggedCount: candidates.length,
      byInstance,
      candidates,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
