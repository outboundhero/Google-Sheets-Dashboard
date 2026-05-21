import { NextResponse } from "next/server";
import { getAllocations, syncAllocations } from "@/lib/client-tag-allocations";

/** GET — returns the cached client-tag → group map (syncs once if empty). */
export async function GET() {
  try {
    const data = await getAllocations();
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** POST — manual "Sync" trigger: re-reads the allocation sheet now. */
export async function POST() {
  try {
    const data = await syncAllocations();
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
