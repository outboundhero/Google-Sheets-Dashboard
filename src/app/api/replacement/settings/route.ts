import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/replacement/store";
import type { ReplacementSettings, ReplacementMode, LookbackWindow } from "@/lib/replacement/types";

// GET  /api/replacement/settings        → current guardrails
// PUT  /api/replacement/settings {...}   → update guardrails (admin-only via middleware)
export async function GET() {
  try {
    return NextResponse.json(await getSettings());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

const MODES: ReplacementMode[] = ["observe", "confirm", "auto"];
const WINDOWS: LookbackWindow[] = ["10", "15", "30", "all"];

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as Partial<ReplacementSettings>;
    const patch: Partial<ReplacementSettings> = {};
    if (body.mode !== undefined) {
      if (!MODES.includes(body.mode)) return NextResponse.json({ error: "invalid mode" }, { status: 400 });
      patch.mode = body.mode;
    }
    if (body.lookbackWindow !== undefined) {
      if (!WINDOWS.includes(body.lookbackWindow)) return NextResponse.json({ error: "invalid lookbackWindow" }, { status: 400 });
      patch.lookbackWindow = body.lookbackWindow;
    }
    if (body.minReplyRate !== undefined) patch.minReplyRate = body.minReplyRate === null ? null : Number(body.minReplyRate);
    if (body.maxBounceRate !== undefined) patch.maxBounceRate = body.maxBounceRate === null ? null : Number(body.maxBounceRate);
    if (body.flagOnSurbl !== undefined) patch.flagOnSurbl = Boolean(body.flagOnSurbl);
    if (body.allowSurblReserves !== undefined) patch.allowSurblReserves = Boolean(body.allowSurblReserves);
    if (body.allowInfoReserves !== undefined) patch.allowInfoReserves = Boolean(body.allowInfoReserves);
    if (body.flagOnSpamhaus !== undefined) patch.flagOnSpamhaus = Boolean(body.flagOnSpamhaus);
    if (body.minSignals !== undefined) patch.minSignals = Math.max(1, Math.floor(Number(body.minSignals)));
    if (body.minSent !== undefined) patch.minSent = Math.max(0, Math.floor(Number(body.minSent)));
    return NextResponse.json(await updateSettings(patch));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
