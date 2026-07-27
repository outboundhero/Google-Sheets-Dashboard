import { NextResponse } from "next/server";
import { dismissAlert } from "@/lib/pipeline-alerts";

// POST /api/pipeline-alerts/dismiss { id } → acknowledge + close a failure box
// without retrying (e.g. handled manually). It stops showing on the dashboard.
export async function POST(request: Request) {
  try {
    const { id } = (await request.json()) as { id?: string };
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    await dismissAlert(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
