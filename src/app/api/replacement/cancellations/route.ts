import { NextResponse } from "next/server";
import { getCancellations } from "@/lib/replacement/store";

// GET /api/replacement/cancellations?status=pending — the vendor-delete queue.
// Read-only; admin-only via middleware. Deletes nothing.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const statuses = status ? status.split(",") : ["pending"];
    return NextResponse.json({ cancellations: await getCancellations(statuses) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
