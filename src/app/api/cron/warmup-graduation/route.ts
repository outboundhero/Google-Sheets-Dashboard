import { NextResponse } from "next/server";

// RETIRED (2026-09-07, Vicky's call) — superseded by /api/cron/limit-policy.
//
// This was the "system that turns warmup off" built 2026-08-29: any inbox
// ≥21 days old got its DAILY limit raised to 10/day. It was never scheduled,
// and four days later Spencer set the numbers that now run daily (Slack,
// 2026-09-02 11:22 PM): reserve inboxes sit at exactly 3/day "without fail",
// and assigned domains go to 5/day once tagged 4 calendar days with active
// campaigns. Both rules turn the SAME daily-limit knob this cron turned, so
// running it would fight the reserve rule every night (3 ↔ 10) and silently
// overwrite the assigned rule's 5 with 10.
//
// If a "veterans get more than 5" rule ever comes from Spencer, add it as a
// stage inside limit-policy — one robot per knob, never two.
export async function GET() {
  return NextResponse.json(
    { retired: true, reason: "superseded by /api/cron/limit-policy (Spencer's 3/5 daily-limit ladder, 2026-09-02)" },
    { status: 410 },
  );
}
