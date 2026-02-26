import { NextResponse } from "next/server";
import { getStoredLeads, getSyncMetadata, isSyncStale } from "@/lib/leads-store";
import { syncAllLeads } from "@/lib/sync-leads";

export async function GET() {
  try {
    // Always serve from Redis instantly — never block on sync
    const meta = await getSyncMetadata();
    const leads = await getStoredLeads();

    // If no data exists or data is stale, trigger background sync
    if ((!meta.lastSyncAt || isSyncStale(meta)) && !meta.syncInProgress) {
      syncAllLeads().catch((err) =>
        console.error("[data/all] Background sync failed:", err)
      );
    }

    return NextResponse.json(leads);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch leads";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
