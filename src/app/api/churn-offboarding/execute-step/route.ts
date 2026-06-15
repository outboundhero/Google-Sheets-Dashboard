import { NextResponse } from "next/server";
import { executePlanStep, type PlanStep } from "@/lib/client-offboarding";

export const maxDuration = 30;

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const step = body?.step as PlanStep | undefined;
    if (!step || typeof step !== "object" || !step.kind) {
      return NextResponse.json({ error: "step is required" }, { status: 400 });
    }
    const result = await executePlanStep(step);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
