import { NextResponse } from "next/server";
import { getAllLeads } from "@/lib/google-sheets";
import { getConfig } from "@/lib/sheets-config";
import { cache } from "@/lib/cache";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const forceRefresh = searchParams.get("refresh");

    // Allow cache busting from the same function instance
    if (forceRefresh) {
      cache.invalidateAll();
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
