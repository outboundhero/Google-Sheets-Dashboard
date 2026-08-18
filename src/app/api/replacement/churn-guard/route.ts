import { NextResponse } from "next/server";
import { getChurnBlackout } from "@/lib/replacement/churn-guard";

export const maxDuration = 30;

// GET /api/replacement/churn-guard?clientTag=ABC
// Returns whether Automatic Domain Replacement is blocked for this tag because
// it's within 5 days of (or past) the client's churn date.
//
// Reads the URL off the plain Request, NOT NextRequest.nextUrl: every
// server-side caller comes through internalFetch, which hands the handler a
// plain Request. `nextUrl` is undefined there, so this threw — and the
// runner's guard check fails open, which silently disabled the blackout for
// every cron-driven run (JPSAN got filled 2 days after churning).
export async function GET(req: Request) {
  const clientTag = new URL(req.url).searchParams.get("clientTag")?.trim();
  if (!clientTag) {
    return NextResponse.json({ error: "clientTag is required" }, { status: 400 });
  }
  try {
    return NextResponse.json(await getChurnBlackout(clientTag));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
