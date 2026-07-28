import { NextResponse } from "next/server";
import { getEvents } from "@/lib/replacement/store";

// GET /api/replacement/events?limit=200 — recent audit-log entries. Admin-only.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Number(searchParams.get("limit") || 200);
    // ?days=7 → trailing window; ?archive=1 → only rows OLDER than the window
    const days = Number(searchParams.get("days") || 0);
    const archive = searchParams.get("archive") === "1";
    const opts = archive
      ? { olderThanDays: days > 0 ? days : 7 }
      : days > 0 ? { withinDays: days } : {};
    return NextResponse.json({ events: await getEvents(Number.isFinite(limit) ? limit : 200, opts) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
