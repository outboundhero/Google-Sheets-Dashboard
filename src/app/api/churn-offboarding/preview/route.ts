import { NextResponse } from "next/server";
import { previewClientOffboarding } from "@/lib/client-offboarding";

export const maxDuration = 30;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const clientAbbr = searchParams.get("clientAbbr");
    if (!clientAbbr?.trim()) {
      return NextResponse.json({ error: "clientAbbr is required" }, { status: 400 });
    }
    const preview = await previewClientOffboarding(clientAbbr);
    return NextResponse.json(preview);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
