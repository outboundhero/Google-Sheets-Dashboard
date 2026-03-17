import { NextResponse } from "next/server";
import { getStoredLeads } from "@/lib/leads-store";
import { computeAnalytics } from "@/lib/analytics";
import { getClientTrackerData } from "@/lib/google-sheets";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const client = searchParams.get("client") || undefined;

    const [leads, trackerData] = await Promise.all([
      getStoredLeads(),
      getClientTrackerData().catch(() => []),
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

    // Find Go Live Date for this client (for billing cycle grouping)
    let goLiveDate: Date | null = null;
    if (client) {
      const row = trackerData.find(
        (c) => c.clientAbbr.trim().toLowerCase() === client.trim().toLowerCase()
      );
      if (row?.goLiveDate) {
        const d = new Date(row.goLiveDate);
        if (!isNaN(d.getTime())) goLiveDate = d;
      }
    }

    const analytics = computeAnalytics(leads, client, churnedClients, goLiveDate);
    return NextResponse.json(analytics);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to compute analytics";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
