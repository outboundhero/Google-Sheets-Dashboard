import { NextResponse } from "next/server";
import { detectWrongInstance } from "@/lib/replacement/wrong-instance";

export const maxDuration = 60;

// GET /api/replacement/wrong-instance — clients whose domains sit on an instance
// in the WRONG group vs their allocation, with the correct target per source.
// Observe-only; the per-client "Run" button moves them via the existing Inboxing
// move flow (POST /api/deliverability/move-domains). Admin-only via middleware.
export async function GET() {
  try {
    return NextResponse.json(await detectWrongInstance());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
