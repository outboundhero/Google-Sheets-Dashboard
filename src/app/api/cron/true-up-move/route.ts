import { NextResponse } from "next/server";
import { POST as moveFill } from "@/app/api/replacement/true-up/move-fill/route";
import { POST as fill } from "@/app/api/replacement/true-up/fill/route";
import { POST as trim } from "@/app/api/replacement/true-up/trim/route";

export const maxDuration = 300;

// GET /api/cron/true-up-move — every 30 minutes: one trim round, one
// cross-instance move round, then an incremental fill.
//
// Nick asked (2026-08-17, 12:12/12:16) for the system to move spare domains
// from an instance that has them to one that is short, then tag, set the
// redirect and attach campaigns. The move lands asynchronously through
// Inboxing's upload queue, so covering a 140-domain shortfall takes many
// rounds spread over hours — this cron runs those rounds server-side instead
// of someone sitting on the Move button.
//
// The fill route says "deliberately a button rather than a cron" — that held
// for the FIRST cycles, which have since been run by hand and verified
// complete (JPWC/JPPH/LC/JPHR, 2026-08-16). With the flow proven and Nick
// explicitly asking for the tag/redirect/attach to follow the move, the same
// fill now runs here in small increments as moved domains land.
//
// Same precedent as the attach-queue cron: import the route handlers and
// invoke them directly, so this executes the exact code path the buttons do.
// Both no-op cheaply when there is nothing to move and nobody is short.

const call = async (
  handler: (req: Request) => Promise<Response>,
  body: unknown,
): Promise<Record<string, unknown>> => {
  const res = await handler(
    new Request("http://internal/api/cron/true-up-move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return res.json().catch(() => ({}));
};

export async function GET() {
  try {
    // Trim first, so domains freed here are in the reserve before the fill
    // runs. Trim was a button for its first cycles, same as the fill was —
    // but fill on a cron with trim manual meant clients only ever drifted UP:
    // SBTB/BHS/CCGLA all sat 9-10 over cap until someone was asked to click
    // (Nick, 2026-08-21, third such request — "so I don't have to come back
    // to you guys"). The route only ever returns HEALTHY domains to reserve;
    // burnt ones stay with the replacement runner's delete path.
    const trimmed = await call(trim, { all: true, maxClients: 2 });

    // One move round: finalize whatever has landed, queue the next batch.
    const move = await call(moveFill, { dryRun: false, maxDomains: 40 });

    // Then top up short clients from whatever reserve is registered by now —
    // small increments; the next tick picks up where this one stopped.
    const filled = await call(fill, { all: true, maxClients: 3 });

    return NextResponse.json({
      trim: {
        ranClients: (trimmed.ranClients as number) ?? 0,
        trimmed: (trimmed.trimmedTotal as number) ?? 0,
        ...(trimmed.error ? { error: trimmed.error } : {}),
      },
      move: {
        moved: (move.movedTotal as number) ?? 0,
        uploading: (move.uploadingTotal as number) ?? 0,
        ...(move.error ? { error: move.error } : {}),
      },
      fill: {
        ranClients: (filled.ranClients as number) ?? 0,
        added: (filled.addedTotal as number) ?? 0,
        ...(filled.error ? { error: filled.error } : {}),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "true-up-move cron failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
