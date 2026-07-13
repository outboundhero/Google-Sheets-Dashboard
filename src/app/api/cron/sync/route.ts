import { NextResponse } from "next/server";
import { syncChunk } from "@/lib/sync-leads";
import { getConfig } from "@/lib/sheets-config";
import { syncSheetsToSupabase } from "@/lib/supabase-sheets-sync";
import { getSyncMetadata, storeSyncMetadata } from "@/lib/leads-store";

export const maxDuration = 60;

// Leads + tracked-sheets mirror. Runs HOURLY (see vercel.json) and RESUMES
// from a persisted round-robin cursor instead of restarting at sheet #0 every
// run — the old behavior time-boxed at 55s and never reached the back half of
// the list (~110 sheets), so those clients' lead data froze for days. Now the
// cursor walks the whole list across successive runs; every sheet refreshes
// within a few hours regardless of its position.
export async function GET() {
  try {
    const config = await getConfig();
    const totalSheets = config.sheets.length;

    // Resume from the saved cursor (clamped — the list can shrink).
    const meta0 = await getSyncMetadata();
    let offset = Math.min(Math.max(meta0.cursor ?? 0, 0), Math.max(totalSheets - 1, 0));
    if (totalSheets === 0) offset = 0;

    let totalSynced = 0;
    let totalErrors = 0;
    let wrapped = false;

    const startTime = Date.now();
    while (totalSheets > 0 && Date.now() - startTime < 55_000) {
      const result = await syncChunk(offset);
      totalSynced += result.sheetsSuccess;
      totalErrors += result.sheetsError;
      // syncChunk returns nextOffset (0 when it just finished the last chunk).
      if (result.complete) {
        offset = 0;      // wrap to the top for the next run
        wrapped = true;
        break;           // one full pass reached the end — stop for this run
      }
      offset = result.nextOffset;
    }

    // Persist the resume point (+ stamp a full-cycle completion when we wrapped).
    const metaAfter = await getSyncMetadata();
    await storeSyncMetadata({
      ...metaAfter,
      cursor: offset,
      lastFullCycleAt: wrapped ? new Date().toISOString() : (metaAfter.lastFullCycleAt ?? null),
    });

    await syncSheetsToSupabase().catch((err) =>
      console.error("[cron/sync] Supabase sheets sync failed:", err)
    );

    return NextResponse.json({
      totalSynced,
      totalErrors,
      totalSheets,
      nextCursor: offset,
      wrappedFullCycle: wrapped,
      durationMs: Date.now() - startTime,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cron sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
