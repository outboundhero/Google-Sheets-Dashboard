import { NextResponse } from "next/server";
import { computePurchasePlan } from "@/lib/replacement/purchase-plan";

export const maxDuration = 60;

// GET /api/replacement/purchase-plan — observe-only "buy X domains per instance".
export async function GET() {
  try {
    return NextResponse.json(await computePurchasePlan());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
