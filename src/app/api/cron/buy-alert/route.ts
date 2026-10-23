import { NextResponse } from "next/server";
import { runBuyAlert } from "@/lib/replacement/buy-alert";

export const maxDuration = 120;

// Daily "buy N domains per instance" Slack digest → #domain-buying (weekly
// until Spencer 2026-10-23 asked for up-to-date numbers every day).
// ?dry=1 returns the numbers without posting.
export async function GET(request: Request) {
  try {
    const p = new URL(request.url).searchParams;
    return NextResponse.json(await runBuyAlert({ dryRun: p.get("dry") === "1" }));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
