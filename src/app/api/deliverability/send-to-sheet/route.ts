import { NextResponse } from "next/server";
import { getConfig } from "@/lib/sheets-config";
import { getSheetMetadata, appendDomainsToSheet } from "@/lib/google-sheets";

/**
 * GET /api/deliverability/send-to-sheet
 * Returns tracked sheets that have a "Domains" tab.
 */
export async function GET() {
  try {
    const config = await getConfig();
    const results = await Promise.allSettled(
      config.sheets.map(async (sheet) => {
        const meta = await getSheetMetadata(sheet.id);
        if (meta.sheetNames.includes("Domains")) {
          return { clientTag: sheet.clientTag, sheetName: meta.title, sheetId: sheet.id };
        }
        return null;
      })
    );

    const sheets: { clientTag: string; sheetName: string; sheetId: string }[] = [];
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        sheets.push(result.value);
      }
    }

    return NextResponse.json({ sheets });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/deliverability/send-to-sheet
 * Body: { domains: string[], clientTag: string }
 * Appends domains to the client's "Domains" tab in Google Sheets.
 */
export async function POST(request: Request) {
  try {
    const { domains, clientTag } = (await request.json()) as {
      domains: string[];
      clientTag: string;
    };

    if (!domains?.length || !clientTag) {
      return NextResponse.json(
        { error: "domains and clientTag are required" },
        { status: 400 }
      );
    }

    // Look up TrackedSheet by clientTag
    const config = await getConfig();
    const sheet = config.sheets.find((s) => s.clientTag === clientTag);
    if (!sheet) {
      return NextResponse.json(
        { error: `No tracked sheet found for client tag "${clientTag}"` },
        { status: 404 }
      );
    }

    // Verify the "Domains" tab exists
    const meta = await getSheetMetadata(sheet.id);
    if (!meta.sheetNames.includes("Domains")) {
      return NextResponse.json(
        { error: `Sheet "${meta.title}" does not have a "Domains" tab` },
        { status: 400 }
      );
    }

    // Append domains
    const result = await appendDomainsToSheet(sheet.id, domains);

    return NextResponse.json({
      added: result.added,
      duplicates: result.duplicates,
      sheetName: meta.title,
      clientTag,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send to sheet";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
