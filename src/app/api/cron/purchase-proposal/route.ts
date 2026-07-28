import { NextResponse } from "next/server";
import { generateProposals } from "@/lib/replacement/purchase-proposal";

export const maxDuration = 120;

// GET /api/cron/purchase-proposal — weekday-morning check: if an instance's
// reserve is short, stage a capped batch of candidate names as a PENDING
// proposal + Slack notify. BUYS NOTHING — purchases only happen when a human
// approves in LeadSync. Skips instances with a proposal already pending.
export async function GET() {
  try {
    return NextResponse.json(await generateProposals());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
