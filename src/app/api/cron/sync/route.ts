import { NextResponse } from "next/server";
import { syncChunk } from "@/lib/sync-leads";
import { getConfig } from "@/lib/sheets-config";
import { syncSheetsToSupabase } from "@/lib/supabase-sheets-sync";
import { getSyncMetadata, storeSyncMetadata } from "@/lib/leads-store";

export const maxDuration = 300;

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

    // Persist the resume cursor after EACH chunk so a mid-run function timeout
    // can never strand the cursor — the next run always resumes from real
    // progress. Budget leaves headroom under maxDuration for a slow chunk
    // (per-sheet fetch can take up to 30s) plus the Supabase mirror below.
    const persistCursor = async (nextCursor: number, didWrap: boolean) => {
      const m = await getSyncMetadata();
      await storeSyncMetadata({
        ...m,
        cursor: nextCursor,
        lastFullCycleAt: didWrap ? new Date().toISOString() : (m.lastFullCycleAt ?? null),
      });
    };

    // Google Sheets allows 300 reads/min per user (the service account), SHARED
    // with the deliverability/campaign/tracker reads. Bursting all ~111 sheets
    // in one run blew that quota and cascaded via retries. So cap each run to a
    // paced batch and let the hourly cursor cover the rest — every sheet still
    // refreshes within a few hours, with big quota headroom for other consumers.
    const MAX_SHEETS_PER_RUN = 40;
    const CHUNK_DELAY_MS = 2500;
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const startTime = Date.now();
    let sheetsThisRun = 0;
    while (
      totalSheets > 0 &&
      sheetsThisRun < MAX_SHEETS_PER_RUN &&
      Date.now() - startTime < 240_000
    ) {
      if (sheetsThisRun > 0) await delay(CHUNK_DELAY_MS); // pace to respect quota
      const result = await syncChunk(offset);
      totalSynced += result.sheetsSuccess;
      totalErrors += result.sheetsError;
      sheetsThisRun += result.sheetsProcessed;
      if (result.complete) {
        offset = 0;      // wrap to the top
        wrapped = true;
        await persistCursor(0, true);
        break;
      }
      offset = result.nextOffset;
      await persistCursor(offset, false);
    }

    await syncSheetsToSupabase().catch((err) =>
      console.error("[cron/sync] Supabase sheets sync failed:", err)
    );

    // Surface which sheets failed this cycle (name + reason) — meta.errors
    // accumulates across the cycle and resets at cursor 0.
    const finalMeta = await getSyncMetadata();

    return NextResponse.json({
      totalSynced,
      totalErrors,
      totalSheets,
      nextCursor: offset,
      wrappedFullCycle: wrapped,
      failedSheets: finalMeta.errors ?? [],
      durationMs: Date.now() - startTime,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cron sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
