import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getSendingModeSettings } from "@/lib/sending-mode/config";
import { listWindows, type SendingWindow } from "@/lib/sending-mode/windows";

// GET /api/performance — everything the Performance tab needs in one read:
// the per-client QL pace rows the hourly sending-mode cron wrote, each
// client's open Turbo/throttle window, the auto-throttle pause switch, the
// window log, and the current tunables.

export interface PerformanceClient {
  clientTag: string;
  companyName: string | null;
  plan: string | null;
  guarantee: number;
  cycleStart: string;
  cycleEnd: string;
  cycleLength: number;
  daysElapsed: number;
  daysRemaining: number;
  qlsDelivered: number;
  expectedToDate: number;
  pace: number | null;
  projected: number;
  status: string;
  leavingOn: string | null;
  leavingKind: string | null;
  evaluatedAt: string;
  turbo: SendingWindow | null;
  throttle: SendingWindow | null;
  autoThrottlePaused: boolean;
}

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
      return {
        clientTag: tag,
        companyName: (r.company_name as string | null) ?? null,
        plan: (r.plan as string | null) ?? null,
        guarantee: Number(r.guarantee),
        cycleStart: String(r.cycle_start),
        cycleEnd: String(r.cycle_end),
        cycleLength: Number(r.cycle_length),
        daysElapsed: Number(r.days_elapsed),
        daysRemaining: Number(r.days_remaining),
        qlsDelivered: Number(r.qls_delivered),
        expectedToDate: Number(r.expected_to_date),
        pace: r.pace === null || r.pace === undefined ? null : Number(r.pace),
        projected: Number(r.projected ?? 0),
        status: String(r.status),
        leavingOn: (r.leaving_on as string | null) ?? null,
        leavingKind: (r.leaving_kind as string | null) ?? null,
        evaluatedAt: String(r.evaluated_at),
        turbo: open.turbo,
        throttle: open.throttle,
        autoThrottlePaused: paused.has(tag),
      };
    });

    const evaluatedAt = clients.reduce<string | null>((m, c) => (!m || c.evaluatedAt > m ? c.evaluatedAt : m), null);
    return NextResponse.json({ clients, windows, settings, evaluatedAt });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
