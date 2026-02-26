import { NextResponse } from "next/server";
import { syncChunk } from "@/lib/sync-leads";
import { getConfig } from "@/lib/sheets-config";

export const maxDuration = 60;

// Cron syncs as many sheets as possible within timeout
// Multiple cron runs will cover all sheets over time
export async function GET() {
  try {
    const config = await getConfig();
    const totalSheets = config.sheets.length;
    let offset = 0;
    let totalSynced = 0;
    let totalErrors = 0;

    // Process chunks until done or approaching timeout
    const startTime = Date.now();
    while (offset < totalSheets && Date.now() - startTime < 45000) {
      const result = await syncChunk(offset);
      totalSynced += result.sheetsSuccess;
      totalErrors += result.sheetsError;
      offset = result.nextOffset || totalSheets;
    }

    return NextResponse.json({
      totalSynced,
      totalErrors,
      totalSheets,
      complete: offset >= totalSheets,
      durationMs: Date.now() - startTime,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cron sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
