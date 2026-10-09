// Auto-throttle preview — what the next daily throttle pass would do, client
// by client, and what it would cost in sends and (roughly) QLs. Read-only:
// the decisions come from the same decideThrottles() the pass runs, on the
// rows the hourly cron last wrote.
//
// Unlike the Turbo preview (one client, live from Bison), this covers every
// client the pass would touch, so account limits come from the dashboard's
// copy of Bison (capacity.ts) — the same numbers the pass uses for its
// "never push a client under target" check.
//
// QLs given up: the rest of the period's projection shrinks with sending
// (projectedIfThrottled) — e.g. keeping 60% of today's sends keeps 60% of the
// QLs still to come.
import { getSupabaseAdmin } from "@/lib/supabase";
import { getSendingModeSettings, type SendingModeSettings } from "./config";
import { lastStatusCutoff, type QlPaceStatus } from "./ql-pace";
import { decideThrottlesWithCapacity, getThrottlePausedSet, projectedIfThrottled, type ClientSendingStatus } from "./status";
import { sendCapacity } from "./capacity";
import { listOpenWindows } from "./windows";

export const THROTTLE_HOUR_UTC = 17;

export interface ThrottlePreviewRow {
  clientTag: string;
  companyName: string | null;
  reason: string;
  pace: number | null;
  qlsDelivered: number;
  guarantee: number;
  projected: number;
  daysRemaining: number;
  accounts: number;
  lowered: number;            // accounts above the throttle limit → lowered to it
  perDayNow: number;
  perDayThrottled: number;
  fewerPerDay: number;
  qlsGivenUp: number;        // if it stays throttled to the end of the period
  projectedAfter: number;
}

export interface ThrottlePreview {
  enabled: boolean;
  nextPassAt: string;
  judgedAt: string | null;
  settings: SendingModeSettings;
  throttle: ThrottlePreviewRow[];
  release: { clientTag: string; reason: string }[];
  leftAlone: { clientTag: string; reason: string }[];
}


function nextPass(now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), THROTTLE_HOUR_UTC));
  if (d <= now) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/** `rows` overrides the stored evaluation (e.g. a fresh evaluateAllClients()). */
export async function buildThrottlePreview(opts: { rows?: ClientSendingStatus[] } = {}): Promise<ThrottlePreview> {
  const supabase = getSupabaseAdmin();
  const [settings, { data: statusRows, error }, open, paused] = await Promise.all([
    getSendingModeSettings(),
    opts.rows ? Promise.resolve({ data: [], error: null }) : supabase.from("client_sending_status").select("*"),
    listOpenWindows(),
    getThrottlePausedSet(),
  ]);
  if (error) throw new Error(error.message);

  const rows: ClientSendingStatus[] = opts.rows?.filter((r) => r.gone === null) ?? ((statusRows || []) as Record<string, unknown>[]).map((r) => ({
    clientTag: String(r.client_tag).toUpperCase(),
    companyName: (r.company_name as string | null) ?? "",
    plan: (r.plan as string | null) ?? "",
    trackerStatus: (r.tracker_status as string | null) ?? "",
    leavingOn: (r.leaving_on as string | null) ?? null,
    leavingKind: (r.leaving_kind as "churn" | "pause" | null) ?? null,
    gone: null,
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
    status: String(r.status) as QlPaceStatus,
    judgedAt: lastStatusCutoff(new Date(String(r.evaluated_at))).toISOString(),
    repliesToDate: 0,
    blankStatusToDate: 0,
  }));
  const byTag = new Map(rows.map((r) => [r.clientTag, r]));
  const decisions = await decideThrottlesWithCapacity(rows, open, paused, settings);

  const toThrottle = decisions.filter((d) => d.action === "throttle");
  const release = decisions.filter((d) => d.action === "release").map((d) => ({ clientTag: d.clientTag, reason: d.reason }));
  // Over the line but the pass leaves them alone — say why, so nobody wonders.
  const leftAlone = decisions
    .filter((d) => d.action === "none" && d.status === "overperforming")
    .map((d) => ({ clientTag: d.clientTag, reason: d.reason }));

  const cap = await sendCapacity(toThrottle.map((d) => d.clientTag), settings.throttleDailyLimit);
  const out: ThrottlePreviewRow[] = [];
  for (const d of toThrottle) {
    const r = byTag.get(d.clientTag)!;
    const c = cap.get(d.clientTag) ?? { accounts: 0, lowered: 0, perDayNow: 0, perDayThrottled: 0, keepRatio: 1 };
    const after = d.projectedIfThrottled ?? projectedIfThrottled(r, c.keepRatio);
    out.push({
      clientTag: d.clientTag,
      companyName: r.companyName || null,
      reason: d.reason,
      pace: r.pace,
      qlsDelivered: r.qlsDelivered,
      guarantee: r.guarantee,
      projected: r.projected,
      daysRemaining: r.daysRemaining,
      accounts: c.accounts,
      lowered: c.lowered,
      perDayNow: c.perDayNow,
      perDayThrottled: c.perDayThrottled,
      fewerPerDay: Math.max(0, c.perDayNow - c.perDayThrottled),
      qlsGivenUp: Math.max(0, r.projected - after),
      projectedAfter: after,
    });
  }
  out.sort((a, b) => (b.pace ?? 0) - (a.pace ?? 0));

  const judgedAt = rows.reduce<string | null>((m, r) => (!m || r.judgedAt > m ? r.judgedAt : m), null);
  return {
    enabled: settings.autoThrottleEnabled,
    nextPassAt: nextPass().toISOString(),
    judgedAt,
    settings,
    throttle: out,
    release,
    leftAlone,
  };
}
