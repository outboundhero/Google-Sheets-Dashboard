import { NextResponse } from "next/server";
import { buildWarmupForecast } from "@/lib/replacement/warmup-forecast";

export const maxDuration = 60;

// GET /api/replacement/warmup-forecast — when reserve domains finish their
// 21-day warm-up, bucketed by completion date. Read-only. Admin-only via
// middleware.
export async function GET() {
  try {
    return NextResponse.json(await buildWarmupForecast());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
