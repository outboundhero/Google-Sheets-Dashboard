import { NextResponse } from "next/server";
import { getLeadsFromSheet } from "@/lib/google-sheets";
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

    // Fallback to "Leads" for existing sheets without sheetName
    const sheetName = sheet.sheetName || "Leads";
    const leads = await getLeadsFromSheet(id, sheetName);
    return NextResponse.json({ sheet, leads });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch sheet data";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
