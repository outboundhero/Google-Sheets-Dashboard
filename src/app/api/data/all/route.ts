import { NextResponse } from "next/server";
import { getAllLeads } from "@/lib/google-sheets";
import { getConfig } from "@/lib/sheets-config";

export async function GET() {
  try {
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
