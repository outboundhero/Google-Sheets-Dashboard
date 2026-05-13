import { NextResponse } from "next/server";
import { syncChunk } from "@/lib/sync-leads";
import { getConfig } from "@/lib/sheets-config";
import { syncSheetsToSupabase } from "@/lib/supabase-sheets-sync";

export const maxDuration = 60;

// Leads + tracked-sheets mirror. Campaign sync lives in /api/cron/campaigns
// (daily). Deliverability inbox/domain sync lives in /api/cron/deliverability.
export async function GET() {
  try {
    const config = await getConfig();
    const totalSheets = config.sheets.length;
    let offset = 0;
    let totalSynced = 0;
    let totalErrors = 0;

    const startTime = Date.now();
    while (offset < totalSheets && Date.now() - startTime < 55_000) {
      const result = await syncChunk(offset);
      totalSynced += result.sheetsSuccess;
      totalErrors += result.sheetsError;
      offset = result.nextOffset || totalSheets;
    }

    await syncSheetsToSupabase().catch((err) =>
      console.error("[cron/sync] Supabase sheets sync failed:", err)
    );

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
