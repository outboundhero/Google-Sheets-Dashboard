import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerSupabaseClient } from "@/lib/supabase";
import { getSettings, updateSettings, logEvents } from "@/lib/replacement/store";
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

    // Mode is the switch that starts/stops the acting engine, and the Aug 17–26
    // observe window was unattributable because nothing recorded the flip
    // (Nick, 2026-08-29: "Why was the system in observe mode?" — we could not
    // answer). Log every change with who saved it, BEFORE applying, so even a
    // failed save attempt of a mode change leaves no gap. Best-effort: a
    // logging failure must never block a settings save.
    if (patch.mode !== undefined) {
      try {
        const before = await getSettings();
        if (before.mode !== patch.mode) {
          let actor = "unknown user";
          try {
            const { data: { user } } = await createServerSupabaseClient(await cookies()).auth.getUser();
            if (user?.email) actor = user.email;
          } catch { /* actor stays unknown */ }
          await logEvents([{
            eventType: "mode_changed",
            detail: `mode changed: ${before.mode} → ${patch.mode} (saved from the Replacement page by ${actor})`,
            signals: { from: before.mode, to: patch.mode, actor },
          }]);
        }
      } catch (e) {
        console.error("[settings] mode-change log failed:", e);
      }
    }

    return NextResponse.json(await updateSettings(patch));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
