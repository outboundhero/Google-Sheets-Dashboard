import { NextResponse } from "next/server";
import { getCapacityStatus, setCapacityLimits } from "@/lib/replacement/bison-capacity";

export const maxDuration = 60;

// GET  /api/replacement/bison-capacity — limits + live sender counts per instance.
// PUT  { limits: { [instance]: number } } — save limits (0 = unknown → gate off).
// Admin-only via middleware.
export async function GET() {
  try {
    return NextResponse.json({ rows: await getCapacityStatus() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as { limits?: Record<string, number> };
    if (!body.limits) return NextResponse.json({ error: "limits required" }, { status: 400 });
    await setCapacityLimits(body.limits);
    return NextResponse.json({ rows: await getCapacityStatus() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
