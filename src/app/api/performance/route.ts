import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getSendingModeSettings } from "@/lib/sending-mode/config";
import { listWindows, type SendingWindow } from "@/lib/sending-mode/windows";
import { lastStatusCutoff } from "@/lib/sending-mode/ql-pace";
import { statusFromRow, type ClientSendingStatus } from "@/lib/sending-mode/status";

// GET /api/performance — everything the Performance tab needs in one read:
// the per-client QL forecast rows the hourly sending-mode cron wrote, each
// client's open Turbo/throttle window, the auto-throttle pause switch, the
// window log, and the current tunables.

export type PerformanceClient = ClientSendingStatus & {
  evaluatedAt: string;
  turbo: SendingWindow | null;
  throttle: SendingWindow | null;
  autoThrottlePaused: boolean;
};

export async function GET() {
  try {
    const supabase = getSupabaseAdmin();
    const [{ data: statusRows, error }, windows, { data: prefRows }, settings] = await Promise.all([
      supabase.from("client_sending_status").select("*").order("client_tag"),
      listWindows(500),
      supabase.from("client_sending_prefs").select("client_tag, auto_throttle_paused"),
      getSendingModeSettings(),
    ]);
    if (error) throw new Error(error.message);

    const openByTag = new Map<string, { turbo: SendingWindow | null; throttle: SendingWindow | null }>();
    for (const w of windows) {
      if (!["applying", "active", "reverting"].includes(w.status)) continue;
      const tag = w.client_tag.toUpperCase();
      const cur = openByTag.get(tag) ?? { turbo: null, throttle: null };
      if (w.kind === "turbo" && !cur.turbo) cur.turbo = w;
      if (w.kind === "throttle" && !cur.throttle) cur.throttle = w;
      openByTag.set(tag, cur);
    }
    const paused = new Set(((prefRows || []) as { client_tag: string; auto_throttle_paused: boolean }[])
      .filter((p) => p.auto_throttle_paused).map((p) => p.client_tag.toUpperCase()));

    const clients: PerformanceClient[] = ((statusRows || []) as Record<string, unknown>[]).map((r) => {
      const tag = String(r.client_tag).toUpperCase();
      const open = openByTag.get(tag) ?? { turbo: null, throttle: null };
      const row = statusFromRow(r);
      return {
        ...row,
        companyName: row.companyName || tag,
        evaluatedAt: String(r.evaluated_at),
        turbo: open.turbo,
        throttle: open.throttle,
        autoThrottlePaused: paused.has(tag),
      };
    });

    const evaluatedAt = clients.reduce<string | null>((m, c) => (!m || c.evaluatedAt > m ? c.evaluatedAt : m), null);
    // Pace and the no-data check are counted to the Friday 5 PM PST cut-off (ql-pace.ts).
    const judgedAt = evaluatedAt ? lastStatusCutoff(new Date(evaluatedAt)).toISOString() : null;
    return NextResponse.json({ clients, windows, settings, evaluatedAt, judgedAt });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
