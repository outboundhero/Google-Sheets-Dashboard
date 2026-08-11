import { NextResponse } from "next/server";
import { runAutoReplacement } from "@/lib/replacement/auto-runner";

// 800s (Fluid compute max): a big client = tag ~1k inboxes + 10-15 campaign
// attaches + removal discovery — run #1 (CWSV) died at 300s mid-chain.
export const maxDuration = 800;

// GET /api/cron/auto-runner — executes the replacement plan WITHOUT a click,
// but ONLY while the guardrail Mode on /replacement is "auto" (observe/confirm
// → no-op). One client per invocation; every action lands in the same event
// log / daily report / retry card as a manual Execute.
// ?dry=1 previews the queue + what the next run would do, in any mode.
// ?max=N (≤3) raises the per-invocation client cap.
export async function GET(request: Request) {
  try {
    const p = new URL(request.url).searchParams;
    const max = Number(p.get("max") || "1");
    return NextResponse.json(await runAutoReplacement({
      dryRun: p.get("dry") === "1",
      maxClients: Number.isFinite(max) ? max : 1,
    }));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
