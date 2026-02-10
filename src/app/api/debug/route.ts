import { NextResponse } from "next/server";
import { google } from "googleapis";
import { getConfig } from "@/lib/sheets-config";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"];

export async function GET() {
  const config = getConfig();
  if (config.sheets.length === 0) {
    return NextResponse.json({ error: "No sheets tracked" });
  }

  const sheet = config.sheets[0];

  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    scopes: SCOPES,
  });

  const sheets = google.sheets({ version: "v4", auth });

  // Fetch header row + first 3 data rows
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheet.id,
    range: "Leads!A1:Z5",
  });

  const rows = response.data.values || [];
  const headers = rows[0] || [];
  const sampleRows = rows.slice(1, 4);

  // Show what column index each header maps to
  const headerMap = headers.map((h: string, i: number) => ({
    index: i,
    column: String.fromCharCode(65 + i),
    header: h,
  }));

  // Show status column specifically
  const statusColIndex = headers.findIndex(
    (h: string) => h.toLowerCase().includes("status")
  );

  const sampleStatuses = sampleRows.map((row: string[]) => ({
    statusAtIndex19: row[19] || "(empty/undefined)",
    statusAtDetected: statusColIndex >= 0 ? row[statusColIndex] || "(empty)" : "(col not found)",
    rowLength: row.length,
  }));

  return NextResponse.json({
    sheetName: sheet.name,
    sheetId: sheet.id,
    headerCount: headers.length,
    headers: headerMap,
    statusColumnDetected: statusColIndex >= 0 ? {
      index: statusColIndex,
      column: String.fromCharCode(65 + statusColIndex),
      name: headers[statusColIndex],
    } : "NOT FOUND",
    sampleStatuses,
    sampleRows: sampleRows.map((row: string[]) =>
      headers.reduce((obj: Record<string, string>, h: string, i: number) => {
        obj[h] = row[i] || "";
        return obj;
      }, {})
    ),
  });
}
