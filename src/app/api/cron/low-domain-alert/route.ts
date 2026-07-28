import { NextResponse } from "next/server";
import { checkLowDomainClients } from "@/lib/replacement/low-domain-alert";

export const maxDuration = 120;

// GET /api/cron/low-domain-alert — weekday-morning "client under domain cap"
// check → one Slack summary with @mentions. Scheduled Mon–Fri 8am PT
// (see vercel.json). ?dry=1 returns the list WITHOUT posting to Slack (testing);
// ?force=1 posts even when no client is low.
export async function GET(request: Request) {
  try {
    const p = new URL(request.url).searchParams;
    return NextResponse.json(
      await checkLowDomainClients({ force: p.get("force") === "1", dryRun: p.get("dry") === "1" }),
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
