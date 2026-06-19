import { NextResponse } from "next/server";
import { deriveCampaignMap } from "@/lib/replacement/campaigns";

export const maxDuration = 60;

// GET /api/replacement/campaign-map — observe-only. Derives, per (client_tag,
// instance), the eligible campaigns a replacement domain would be attached to,
// plus the real status distribution + blank-tag count so the status filter can
// be validated. Reads only; admin-only via middleware.
export async function GET() {
  try {
    const result = await deriveCampaignMap();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
