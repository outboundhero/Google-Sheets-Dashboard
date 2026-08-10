import { NextResponse } from "next/server";
import { runCampaignsRefresh } from "@/lib/cron/refresh-campaigns";

// Daily 12pm-PT full campaigns reconcile: list sync of all 4 instances + bounded
// schedule/sender enrichment. See vercel.json.
export const maxDuration = 300;

export async function GET() {
  const result = await runCampaignsRefresh();
  return NextResponse.json(result);
}
