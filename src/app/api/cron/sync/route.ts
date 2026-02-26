import { NextResponse } from "next/server";
import { syncAllLeads } from "@/lib/sync-leads";

export const maxDuration = 60;

export async function GET() {
  try {
    const result = await syncAllLeads();
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cron sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
