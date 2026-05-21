import { NextResponse } from "next/server";
import { syncAllocations } from "@/lib/client-tag-allocations";

/** Daily cron — refreshes the client-tag → group allocation map from the sheet. */
export async function GET() {
  try {
    const data = await syncAllocations();
    return NextResponse.json({
      ok: true,
      group1Count: data.group1Count,
      group2Count: data.group2Count,
      syncedAt: data.syncedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
