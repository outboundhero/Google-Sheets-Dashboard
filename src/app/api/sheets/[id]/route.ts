import { NextResponse } from "next/server";
import { getStoredSheetLeads } from "@/lib/leads-store";
import { getConfig } from "@/lib/sheets-config";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const config = await getConfig();
    const sheet = config.sheets.find((s) => s.id === id);

    if (!sheet) {
      return NextResponse.json({ error: "Sheet not found" }, { status: 404 });
    }

    const leads = await getStoredSheetLeads(id);
    return NextResponse.json({ sheet, leads });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch sheet data";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
