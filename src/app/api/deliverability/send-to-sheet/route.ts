import { NextResponse } from "next/server";
import { getConfig } from "@/lib/sheets-config";
import { getSheetMetadata, appendDomainsToSheet } from "@/lib/google-sheets";

interface SheetInfo {
  clientTag: string;
  sheetName: string;
  sheetId: string;
}

// Cache available sheets for 10 minutes to avoid hammering Google Sheets API
let cachedSheets: SheetInfo[] | null = null;
let cachedAt = 0;
const CACHE_TTL = 10 * 60 * 1000;

async function getAvailableSheets(): Promise<SheetInfo[]> {
  if (cachedSheets && Date.now() - cachedAt < CACHE_TTL) {
    return cachedSheets;
  }

  const config = await getConfig();

  // Check sheets sequentially in batches of 5 to avoid quota issues
  const sheets: SheetInfo[] = [];
  for (let i = 0; i < config.sheets.length; i += 5) {
    const batch = config.sheets.slice(i, i + 5);
    const results = await Promise.allSettled(
      batch.map(async (sheet) => {
        const meta = await getSheetMetadata(sheet.id);
        if (meta.sheetNames.includes("Domains")) {
          return { clientTag: sheet.clientTag, sheetName: meta.title, sheetId: sheet.id };
        }
        return null;
      })
    );
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        sheets.push(result.value);
      }
    }
  }

  cachedSheets = sheets;
  cachedAt = Date.now();
  return sheets;
}

/**
 * GET /api/deliverability/send-to-sheet
 * Returns tracked sheets that have a "Domains" tab (cached).
 */
export async function GET() {
  try {
    const sheets = await getAvailableSheets();
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

    // Look up sheet directly from config (no Google Sheets API calls)
    const config = await getConfig();
    const tracked = config.sheets.find((s) => s.clientTag === clientTag);
    if (!tracked) {
      return NextResponse.json(
        { error: `No tracked sheet found for client tag "${clientTag}"` },
        { status: 404 }
      );
    }
    const sheetId = tracked.id;
    const sheetName = tracked.name;

    // Append domains (appendDomainsToSheet reads existing for dedup + writes — 2 API calls total)
    const result = await appendDomainsToSheet(sheetId, domains);

    return NextResponse.json({
      added: result.added,
      duplicates: result.duplicates,
      sheetName,
      clientTag,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send to sheet";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
