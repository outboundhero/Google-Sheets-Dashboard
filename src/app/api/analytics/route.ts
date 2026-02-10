import { NextResponse } from "next/server";
import { getAllLeads } from "@/lib/google-sheets";
import { getConfig } from "@/lib/sheets-config";
import { computeAnalytics } from "@/lib/analytics";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const client = searchParams.get("client") || undefined;

    const config = getConfig();

    if (config.sheets.length === 0) {
      return NextResponse.json(
        computeAnalytics([], client)
      );
    }

    const leads = await getAllLeads(config.sheets);
    const analytics = computeAnalytics(leads, client);
    return NextResponse.json(analytics);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to compute analytics";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
