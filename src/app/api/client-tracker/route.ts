import { NextResponse } from "next/server";
import { getClientTrackerData } from "@/lib/google-sheets";

export async function GET() {
  try {
    const data = await getClientTrackerData();
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch client tracker";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
