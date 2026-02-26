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

    // Prevent concurrent syncs (with 5-minute timeout safeguard)
    if (meta.syncInProgress && meta.syncStartedAt) {
      const elapsed = Date.now() - new Date(meta.syncStartedAt).getTime();
      if (elapsed < 5 * 60 * 1000) {
        return NextResponse.json(
          { error: "Sync already in progress", startedAt: meta.syncStartedAt },
          { status: 409 }
        );
      }
    }

    const result = await syncAllLeads();
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
