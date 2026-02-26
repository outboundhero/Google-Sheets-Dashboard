import { NextResponse } from "next/server";
import { getStoredLeads, getSyncMetadata } from "@/lib/leads-store";
import { syncAllLeads } from "@/lib/sync-leads";
import { computeAnalytics } from "@/lib/analytics";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const client = searchParams.get("client") || undefined;

    // If no data synced yet, trigger initial sync
    const meta = await getSyncMetadata();
    if (!meta.lastSyncAt) {
      await syncAllLeads();
    }

    const leads = await getStoredLeads();
    const analytics = computeAnalytics(leads, client);
    return NextResponse.json(analytics);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to compute analytics";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
