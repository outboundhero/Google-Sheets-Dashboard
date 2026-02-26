import { NextResponse } from "next/server";
import { syncAllLeads } from "@/lib/sync-leads";
import { getSyncMetadata, isSyncStale } from "@/lib/leads-store";

export const maxDuration = 60;

export async function GET() {
  try {
    const meta = await getSyncMetadata();
    return NextResponse.json({
      ...meta,
      isStale: isSyncStale(meta),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to get sync status";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST() {
  try {
    const meta = await getSyncMetadata();

    // If sync already in progress, return current status (don't block with 409)
    if (meta.syncInProgress && meta.syncStartedAt) {
      const elapsed = Date.now() - new Date(meta.syncStartedAt).getTime();
      if (elapsed < 5 * 60 * 1000) {
        return NextResponse.json({
          message: "Sync already in progress",
          ...meta,
        });
      }
      // If stuck for >5 min, force a new sync (old one likely crashed)
    }

    const result = await syncAllLeads();
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
