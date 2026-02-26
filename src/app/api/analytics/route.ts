import { NextResponse } from "next/server";
import { getStoredLeads } from "@/lib/leads-store";
import { computeAnalytics } from "@/lib/analytics";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const client = searchParams.get("client") || undefined;

    // Always serve from Redis instantly
    const leads = await getStoredLeads();
    const analytics = computeAnalytics(leads, client);
    return NextResponse.json(analytics);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to compute analytics";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
