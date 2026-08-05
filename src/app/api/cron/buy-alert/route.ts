import { NextResponse } from "next/server";
import { runBuyAlert } from "@/lib/replacement/buy-alert";

export const maxDuration = 120;

// Weekly "buy N domains per instance" Slack digest → #domain-buying.
// ?dry=1 returns the numbers without posting; ?force=1 posts even at 0 short.
export async function GET(request: Request) {
  try {
    const p = new URL(request.url).searchParams;
    return NextResponse.json(await runBuyAlert({ force: p.get("force") === "1", dryRun: p.get("dry") === "1" }));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
