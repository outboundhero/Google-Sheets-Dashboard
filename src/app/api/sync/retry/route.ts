import { NextResponse } from "next/server";
import { retryFailedSheets } from "@/lib/sync-leads";

export const maxDuration = 300;

// POST /api/sync/retry — re-sync only the named sheets (Spencer 2026-08-18:
// when the full Sync ends with "(N failed)", retry those N without running
// all 136 again). Body: { sheetIds: string[] } — capped at 10 per call so the
// worst case (every sheet timing out at 30s) stays inside the function limit.

const MAX_SHEETS = 10;

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { sheetIds?: unknown };
    const sheetIds = Array.isArray(body.sheetIds)
      ? body.sheetIds.filter((x): x is string => typeof x === "string" && x.length > 0)
      : [];
    if (sheetIds.length === 0) {
      return NextResponse.json({ error: "sheetIds required" }, { status: 400 });
    }
    const result = await retryFailedSheets(sheetIds.slice(0, MAX_SHEETS));
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Retry failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
