import { NextResponse } from "next/server";
import { getThresholdConfig } from "@/lib/replacement/threshold-groups-store";
import { buildReplacementPlan } from "@/lib/replacement/plan";

export const maxDuration = 60;

// GET /api/replacement/plan-groups — OBSERVE-ONLY. The SAME full replacement plan
// as /api/replacement/plan (pull reserve → tag → redirect → attach → remove), but
// burnt-domain detection is driven by Spencer's segmented threshold GROUPS instead
// of the flat guardrails. SURBL/Spamhaus play no part (the default groups don't
// reference them). Reads Supabase only; executes NOTHING on Bison or any provider.
// Returns { enabled: false } while the groups are turned off — flip them on + save
// in the Threshold-groups editor to see this.
export async function GET() {
  try {
    const cfg = await getThresholdConfig();
    if (!cfg.enabled) {
      return NextResponse.json({ enabled: false });
    }
    const plan = await buildReplacementPlan({ burntSource: "groups", groupConfig: cfg, infoMigration: false });
    return NextResponse.json({ enabled: true, ...plan });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
