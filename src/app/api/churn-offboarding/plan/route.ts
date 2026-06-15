import { NextResponse } from "next/server";
import { planClientOffboarding } from "@/lib/client-offboarding";

export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const clientAbbr = searchParams.get("clientAbbr");
    if (!clientAbbr?.trim()) {
      return NextResponse.json({ error: "clientAbbr is required" }, { status: 400 });
    }
    const plan = await planClientOffboarding(clientAbbr);
    return NextResponse.json(plan);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
