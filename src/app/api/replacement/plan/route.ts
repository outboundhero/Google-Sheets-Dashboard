import { NextResponse } from "next/server";
import { buildReplacementPlan } from "@/lib/replacement/plan";
import { getThresholdConfig } from "@/lib/replacement/threshold-groups-store";

export const maxDuration = 120;

// GET /api/replacement/plan — OBSERVE-ONLY. For each burnt domain, returns the
// full proposed replacement (client tag, instance, redirect, target campaigns,
// the reserve domain it would pull, cap check, and any blockers). Executes
// nothing. Admin-only via middleware.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const v = searchParams.get("infoMigration");
    const infoMigration = v === "1" || v === "true";
    // Same detector everywhere (Nick 2026-08-19 "everything off the groups"):
    // when the threshold groups are enabled they drive this plan too — it is
    // the plan the Execute-for-one-client path and the ExecuteDialog run, and
    // with the flat guardrails it came back EMPTY (0 burnt) while the auto-
    // runner, alerts and Flagged view all saw 298 burnt domains (2026-08-27).
    const cfg = await getThresholdConfig();
    const plan = cfg.enabled
      ? await buildReplacementPlan({ infoMigration, burntSource: "groups", groupConfig: cfg })
      : await buildReplacementPlan({ infoMigration });
    return NextResponse.json(plan);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
