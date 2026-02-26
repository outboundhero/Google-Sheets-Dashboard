import { NextResponse } from "next/server";
import { syncChunk } from "@/lib/sync-leads";
import { getSyncMetadata, isSyncStale } from "@/lib/leads-store";

export const maxDuration = 60;

export async function GET() {
  try {
    const meta = await getSyncMetadata();
    return NextResponse.json({
      ...meta,
      isStale: isSyncStale(meta),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to get sync status";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const offset = parseInt(searchParams.get("offset") || "0", 10);

    const result = await syncChunk(offset);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
