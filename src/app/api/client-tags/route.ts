import { NextResponse } from "next/server";
import { getAllClientTags } from "@/lib/google-sheets";

export async function GET() {
  try {
    const tags = await getAllClientTags();
    return NextResponse.json(tags);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch client tags";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
