import { NextRequest, NextResponse } from "next/server";
import { getChurnBlackout } from "@/lib/replacement/churn-guard";

export const maxDuration = 30;

// GET /api/replacement/churn-guard?clientTag=ABC
// Returns whether Automatic Domain Replacement is blocked for this tag because
// it's within 5 days of (or past) the client's churn date.
export async function GET(req: NextRequest) {
  const clientTag = req.nextUrl.searchParams.get("clientTag")?.trim();
  if (!clientTag) {
    return NextResponse.json({ error: "clientTag is required" }, { status: 400 });
  }
  try {
    return NextResponse.json(await getChurnBlackout(clientTag));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
