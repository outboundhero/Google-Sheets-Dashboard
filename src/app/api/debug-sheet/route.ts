import { NextResponse } from "next/server";
import { getSheetMetadata } from "@/lib/google-sheets";
import { google } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"];

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
    const sheetName = searchParams.get("sheetName") || "Combined";

    if (!sheetId) {
      return NextResponse.json(
        { error: "sheetId parameter is required" },
        { status: 400 }
      );
    }

    // Get metadata
    const metadata = await getSheetMetadata(sheetId);

    // Get data from specified sheet
    const client = await getSheetsClient();
    const response = await client.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${sheetName}!A1:AZ10`, // First 10 rows only
    });

    const rows = response.data.values || [];
    const headers = rows[0] || [];
    const dataRows = rows.slice(1);

    return NextResponse.json({
      spreadsheetTitle: metadata.title,
      availableSheets: metadata.sheetNames,
      selectedSheet: sheetName,
      headers,
      rowCount: dataRows.length,
      sampleData: dataRows.slice(0, 3), // First 3 data rows
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch sheet data";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
