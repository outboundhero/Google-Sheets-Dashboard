import { NextResponse } from "next/server";
import { listOpenAlerts } from "@/lib/pipeline-alerts";

export const maxDuration = 30;

// GET /api/pipeline-alerts → every OPEN pipeline failure, for the persistent
// dashboard banner. Polled by the client; empty list hides the banner.
export async function GET() {
  try {
    const alerts = await listOpenAlerts();
    return NextResponse.json({ alerts });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
