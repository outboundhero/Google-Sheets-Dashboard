import { NextResponse } from "next/server";
import { buildReplacementPlan } from "@/lib/replacement/plan";

export const maxDuration = 120;

// GET /api/replacement/plan — OBSERVE-ONLY. For each burnt domain, returns the
// full proposed replacement (client tag, instance, redirect, target campaigns,
// the reserve domain it would pull, cap check, and any blockers). Executes
// nothing. Admin-only via middleware.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const v = searchParams.get("infoMigration");
    const infoMigration = v === "1" || v === "true";
    return NextResponse.json(await buildReplacementPlan({ infoMigration }));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
