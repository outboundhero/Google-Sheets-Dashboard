import { NextResponse } from "next/server";
import { getEvents } from "@/lib/replacement/store";

// GET /api/replacement/events?limit=200 — recent audit-log entries. Admin-only.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Number(searchParams.get("limit") || 200);
    return NextResponse.json({ events: await getEvents(Number.isFinite(limit) ? limit : 200) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
