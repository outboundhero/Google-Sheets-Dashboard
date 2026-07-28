import { NextResponse } from "next/server";
import { checkReserveAndAlert } from "@/lib/replacement/reserve-alert";

export const maxDuration = 120;

// GET /api/cron/reserve-alert — daily reserve-shortage check → Slack DM.
// ?force=1 posts a summary even when there's no issue (handy for testing).
export async function GET(request: Request) {
  try {
    const force = new URL(request.url).searchParams.get("force") === "1";
    return NextResponse.json(await checkReserveAndAlert({ force }));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
