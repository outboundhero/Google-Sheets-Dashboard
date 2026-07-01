import { NextResponse } from "next/server";
import { executePlanStep, type PlanStep } from "@/lib/client-offboarding";

// Detag batches of 50 sender-emails against /tags/remove-from-sender-emails
// can genuinely take longer than 30s when Bison is under load (or when the
// 422 fallback path retries each id individually). At 30s Vercel was killing
// the response mid-write → FE saw "non-JSON response, transient" → detag
// tally stayed at 0 with 0 failures logged. 120s is well over the observed
// slow-path worst case.
export const maxDuration = 120;

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
