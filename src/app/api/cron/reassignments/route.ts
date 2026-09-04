import { NextResponse } from "next/server";
import { processDueReassignments } from "@/lib/replacement/reassignments";

// Every 15 min: advance due reassignment rows through the stage machine.
// Bison calls inside (campaign removal / tag / attach) can be slow on
// rate-limited instances — generous ceiling, small batch.
export const maxDuration = 600;

export async function GET() {
  try {
    const result = await processDueReassignments();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
