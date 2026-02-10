import { NextResponse } from "next/server";
import { cache } from "@/lib/cache";

export async function DELETE() {
  cache.invalidateAll();
  return NextResponse.json({ success: true });
}
