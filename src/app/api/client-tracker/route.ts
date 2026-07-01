import { NextResponse } from "next/server";
import { getClientTrackerData } from "@/lib/google-sheets";
import { cache } from "@/lib/cache";

// GET /api/client-tracker           → cached (up to 30 min stale)
// GET /api/client-tracker?refresh=1 → busts the server-side cache first,
//                                     forces a fresh sheet read. Used by the
//                                     "refresh" buttons on the dashboard so an
//                                     edit to the Client Tracker sheet shows
//                                     up on demand.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    if (searchParams.get("refresh") === "1") {
      cache.invalidate("client-tracker-data");
    }
    const data = await getClientTrackerData();
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch client tracker";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
