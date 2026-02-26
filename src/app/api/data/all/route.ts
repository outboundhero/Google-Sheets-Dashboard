import { NextResponse } from "next/server";
import { getAllLeads } from "@/lib/google-sheets";
import { getConfig } from "@/lib/sheets-config";
import { cache } from "@/lib/cache";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const forceRefresh = searchParams.get("refresh");

    // Only clear the aggregated leads cache, keep per-sheet data cached
    // This avoids re-fetching all 75+ sheets from Google API on refresh
    if (forceRefresh) {
      cache.invalidate("all-leads");
    }

    const config = await getConfig();

    if (config.sheets.length === 0) {
      return NextResponse.json([]);
    }

    const leads = await getAllLeads(config.sheets);
    return NextResponse.json(leads);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch all leads";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
