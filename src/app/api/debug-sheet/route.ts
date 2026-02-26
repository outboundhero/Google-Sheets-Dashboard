import { NextResponse } from "next/server";
import { getSheetMetadata, getLeadsFromSheet } from "@/lib/google-sheets";
import { getConfig } from "@/lib/sheets-config";
import { google } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"];

// Escape sheet names for Google Sheets A1 notation
function escapeSheetName(name: string): string {
  if (/[^a-zA-Z0-9_]/.test(name)) {
    return `'${name.replace(/'/g, "''")}'`;
  }
  return name;
}

async function getSheetsClient() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    scopes: SCOPES,
  });
  return google.sheets({ version: "v4", auth });
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const sheetId = searchParams.get("sheetId");
    const sheetName = searchParams.get("sheetName");
    const showConfig = searchParams.get("config");

    // If config param is set, return the stored config
    if (showConfig) {
      const config = await getConfig();
      return NextResponse.json({
        storedConfig: config.sheets.map((s) => ({
          id: s.id,
          name: s.name,
          clientTag: s.clientTag,
          sheetName: s.sheetName || "(default: Leads)",
          addedAt: s.addedAt,
        })),
      });
    }

    if (!sheetId) {
      return NextResponse.json(
        { error: "sheetId parameter is required. Use ?config=1 to see stored config." },
        { status: 400 }
      );
    }

    // Get metadata
    const metadata = await getSheetMetadata(sheetId);

    // Use provided sheet name or first available
    const tabName = sheetName || metadata.sheetNames[0] || "Sheet1";
    const escapedRange = `${escapeSheetName(tabName)}!A1:AZ10`;

    // Get data from specified sheet
    const client = await getSheetsClient();
    const response = await client.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: escapedRange,
    });

    const rows = response.data.values || [];
    const headers = rows[0] || [];
    const dataRows = rows.slice(1);

    // Also try fetching leads through the normal pipeline
    let leadsResult;
    try {
      const leads = await getLeadsFromSheet(sheetId, tabName);
      leadsResult = {
        totalLeads: leads.length,
        sampleLeads: leads.slice(0, 2).map((l) => ({
          email: l.email,
          name: l.name,
          duplicateCheck: l.duplicateCheck,
          status: l.status,
        })),
      };
    } catch (e) {
      leadsResult = { error: e instanceof Error ? e.message : "Failed" };
    }

    return NextResponse.json({
      spreadsheetTitle: metadata.title,
      availableSheets: metadata.sheetNames,
      selectedSheet: tabName,
      escapedRange,
      headers,
      rowCount: dataRows.length,
      sampleData: dataRows.slice(0, 3),
      leadsFromPipeline: leadsResult,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch sheet data";
    return NextResponse.json({ error: message, stack: error instanceof Error ? error.stack : undefined }, { status: 500 });
  }
}
