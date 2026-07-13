import { NextResponse } from "next/server";
import { getStoredLeadsWithFreshness, getSyncMetadata } from "@/lib/leads-store";
import { computeAnalytics } from "@/lib/analytics";
import { getClientTrackerData } from "@/lib/google-sheets";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const client = searchParams.get("client") || undefined;

    const [{ leads, syncedAtByClient }, trackerData, syncMeta] = await Promise.all([
      getStoredLeadsWithFreshness(),
      getClientTrackerData().catch(() => []),
      getSyncMetadata().catch(() => null),
    ]);

    // Exclude clients whose churn date has already passed
    const now = new Date();
    const churnedClients = trackerData
      .filter((c) => {
        if (!c.churnDate) return false;
        const d = new Date(c.churnDate);
        return !isNaN(d.getTime()) && d <= now;
      })
      .map((c) => c.clientAbbr);

    // Find Start Date for this client (for billing cycle grouping), fall back to Go Live Date
    let billingStartDate: Date | null = null;
    if (client) {
      const row = trackerData.find(
        (c) => c.clientAbbr.trim().toLowerCase() === client.trim().toLowerCase()
      );
      const dateStr = row?.startDate || row?.goLiveDate;
      if (dateStr) {
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) billingStartDate = d;
      }
    }

    const analytics = computeAnalytics(leads, client, churnedClients, billingStartDate, syncedAtByClient);
    return NextResponse.json({
      ...analytics,
      leadsLastFullCycleAt: syncMeta?.lastFullCycleAt ?? null,
      leadsLastSyncAt: syncMeta?.lastSyncAt ?? null,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to compute analytics";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
