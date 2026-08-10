import { NextResponse } from "next/server";
import { drainDuplicationOnce } from "@/lib/campaigns/duplication-drain";

// Processes one client-tag set from the shared duplication queue. Called
// repeatedly by the FE loop while its panel is open, and by the cron backstop.
export const maxDuration = 60;

export async function POST() {
  try {
    const result = await drainDuplicationOnce();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
