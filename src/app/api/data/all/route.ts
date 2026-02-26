import { NextResponse } from "next/server";
import { getStoredLeads } from "@/lib/leads-store";

export async function GET() {
  try {
    // Pure Redis read — instant response, no sync triggers
    const leads = await getStoredLeads();
    return NextResponse.json(leads);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch leads";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
