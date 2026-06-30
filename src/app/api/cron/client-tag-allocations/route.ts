import { NextResponse } from "next/server";
import { syncAllocations } from "@/lib/client-tag-allocations";
import { cache } from "@/lib/cache";

/** Daily cron — refreshes the client-tag → group allocation map from the sheet.
 *  Also invalidates the in-memory Client Tracker cache so freshly-churned tags
 *  show up everywhere they're consulted (Campaigns "Churned clients" filter,
 *  home dashboard churn card, churn-offboarding scan) within one request.
 */
export async function GET() {
  try {
    const data = await syncAllocations();
    cache.invalidate("client-tracker-data");
    return NextResponse.json({
      ok: true,
      group1Count: data.group1Count,
      group2Count: data.group2Count,
      syncedAt: data.syncedAt,
      clientTrackerCacheInvalidated: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
