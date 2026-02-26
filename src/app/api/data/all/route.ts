import { NextResponse } from "next/server";
import { getStoredLeads, getSyncMetadata, isSyncStale } from "@/lib/leads-store";
import { syncAllLeads } from "@/lib/sync-leads";

export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const forceRefresh = searchParams.get("refresh");

    // If refresh requested, trigger a full sync first
    if (forceRefresh) {
      await syncAllLeads();
      const leads = await getStoredLeads();
      return NextResponse.json(leads);
    }

    // Check if we have any stored data
    const meta = await getSyncMetadata();

    if (!meta.lastSyncAt) {
      // First load ever — trigger initial sync
      await syncAllLeads();
      const leads = await getStoredLeads();
      return NextResponse.json(leads);
    }

    // Serve stored data immediately
    const leads = await getStoredLeads();

    // If stale, trigger background sync for next request
    if (isSyncStale(meta) && !meta.syncInProgress) {
      // Fire-and-forget: sync in background, don't await
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
