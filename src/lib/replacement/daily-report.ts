// End-of-day replacement report (Spencer's Loom, 2026-07-27): "at the end of the
// day, report what the replacement system did" — dashboard + Slack. Built from
// the REAL audit log (`replacement_events`, written by execution) plus a live
// detection snapshot, for one PST day. READ-ONLY + notify — executes nothing.
import { getSupabaseAdmin } from "@/lib/supabase";
import { pstDateString } from "@/lib/date-utils";
import { postSlackMessage } from "@/lib/slack";
import { buildReplacementPlan } from "./plan";
import { getThresholdConfig } from "./threshold-groups-store";
import { getSettings, getCancellations } from "./store";
import type { ReplacementEventType } from "./types";

const CHUNK_LINES = 40; // thread-reply size for the detailed event list

/** UTC window covering one PST (UTC-8, no DST — repo convention) calendar day. */
function pstDayWindow(date: string): { startIso: string; endIso: string } {
  const start = Date.parse(`${date}T08:00:00Z`);
  return { startIso: new Date(start).toISOString(), endIso: new Date(start + 86_400_000).toISOString() };
}

interface EventRow {
  instance: string | null;
  domain: string | null;
  client_tag: string | null;
  event_type: ReplacementEventType;
  detail: string | null;
  created_at: string;
}

export interface DailyClientActivity {
  clientTag: string;
  instance: string;
  tagged: number;
  redirects: number;
  attached: number;
  removed: number;
  errors: number;
}

export interface DailyReplacementReport {
  date: string;                    // PST day the report covers
  mode: string;                    // observe | execute
  detector: "groups" | "guardrails";
  totals: Record<"tagged" | "redirect_set" | "attached" | "removed" | "cancel_queued" | "skipped" | "error", number>;
  eventCount: number;
  byClient: DailyClientActivity[];
  errors: { clientTag: string | null; instance: string | null; domain: string | null; detail: string | null; at: string }[];
  detection: { burnt: number; ready: number; blocked: number; removeOnly: number };
  pendingCancellations: number;
  nextCancellation: string | null; // earliest scheduled_at still pending
}

export async function buildDailyReplacementReport(date?: string): Promise<DailyReplacementReport> {
  const day = date || pstDateString(new Date());
  const { startIso, endIso } = pstDayWindow(day);
  const supabase = getSupabaseAdmin();

  // 1) the day's audit events
  const events: EventRow[] = [];
  let off = 0;
  while (true) {
    const { data, error } = await supabase
      .from("replacement_events")
      .select("instance,domain,client_tag,event_type,detail,created_at")
      .gte("created_at", startIso)
      .lt("created_at", endIso)
      .order("created_at", { ascending: true })
      .range(off, off + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    events.push(...(data as EventRow[]));
    if (data.length < 1000) break;
    off += 1000;
  }

  const totals: DailyReplacementReport["totals"] = {
    tagged: 0, redirect_set: 0, attached: 0, removed: 0, cancel_queued: 0, skipped: 0, error: 0,
  };
  const byKey = new Map<string, DailyClientActivity>();
  const errors: DailyReplacementReport["errors"] = [];
  for (const e of events) {
    if (e.event_type in totals) totals[e.event_type as keyof typeof totals]++;
    const tag = e.client_tag || "—";
    const inst = e.instance || "—";
    const k = `${tag}|${inst}`;
    let row = byKey.get(k);
    if (!row) { row = { clientTag: tag, instance: inst, tagged: 0, redirects: 0, attached: 0, removed: 0, errors: 0 }; byKey.set(k, row); }
    if (e.event_type === "tagged") row.tagged++;
    else if (e.event_type === "redirect_set") row.redirects++;
    else if (e.event_type === "attached") row.attached++;
    else if (e.event_type === "removed") row.removed++;
    else if (e.event_type === "error") {
      row.errors++;
      errors.push({ clientTag: e.client_tag, instance: e.instance, domain: e.domain, detail: e.detail, at: e.created_at });
    }
  }
  const byClient = [...byKey.values()].sort((a, b) => (b.removed + b.tagged) - (a.removed + a.tagged));

  // 2) live detection snapshot (groups when enabled — same detector being tested)
  const [settings, groupCfg] = await Promise.all([getSettings(), getThresholdConfig()]);
  const detector = groupCfg.enabled ? "groups" as const : "guardrails" as const;
  const plan = await buildReplacementPlan(
    detector === "groups" ? { burntSource: "groups", groupConfig: groupCfg } : {},
  );
  const ready = plan.items.filter((i) => !i.removeOnly && i.blockers.length === 0 && i.replacementDomain).length;
  const removeOnly = plan.items.filter((i) => i.removeOnly).length;
  const detection = {
    burnt: plan.burntCount,
    ready,
    removeOnly,
    blocked: plan.burntCount - ready - removeOnly,
  };

  // 3) cancellation queue state
  const pending = await getCancellations(["pending"]);

  return {
    date: day,
    mode: settings.mode,
    detector,
    totals,
    eventCount: events.length,
    byClient,
    errors,
    detection,
    pendingCancellations: pending.length,
    nextCancellation: pending[0]?.scheduledAt ?? null,
  };
}

/** Channel: own env first, then the shared LeadSync-Outbound chain. */
function channelId(): string | undefined {
  return process.env.SLACK_REPLACEMENT_REPORT_CHANNEL_ID
    || process.env.SLACK_OUTBOUND_CHANNEL_ID
    || process.env.SLACK_LEAD_SYNC_CHANNEL_ID
    || "C0B84LMSVMH";
}

export interface DailyReportSendResult {
  report: DailyReplacementReport;
  alerted: boolean;
  slackReason?: string;
}

/** Build the report and post it to Slack. Summary in the channel; per-client
 *  breakdown + errors in the thread when there was any activity. */
export async function sendDailyReplacementReport(
  opts: { date?: string; dryRun?: boolean } = {},
): Promise<DailyReportSendResult> {
  const r = await buildDailyReplacementReport(opts.date);
  if (opts.dryRun) return { report: r, alerted: false, slackReason: "dry run" };

  const acted = r.totals.tagged + r.totals.redirect_set + r.totals.attached + r.totals.removed + r.totals.error > 0;
  const main: string[] = [`*🌙 Replacement daily report — LeadSync* (${r.date})`];
  main.push(`Mode: *${r.mode}* · Detector: *${r.detector}*`);
  if (acted) {
    main.push(`Today: removed *${r.totals.removed}* · tagged *${r.totals.tagged}* · campaigns attached *${r.totals.attached}* · redirects set *${r.totals.redirect_set}* · errors *${r.totals.error}*`);
    main.push(`🧵 Per-client breakdown${r.errors.length ? " + errors" : ""} in the thread`);
  } else {
    main.push("_No execution activity today._");
  }
  main.push(`Detection now: *${r.detection.burnt}* burnt · *${r.detection.ready}* replacement-ready · *${r.detection.blocked}* blocked · *${r.detection.removeOnly}* remove-only (at cap)`);
  main.push(`Pending vendor-cancellations: *${r.pendingCancellations}*${r.nextCancellation ? ` (next: ${r.nextCancellation.slice(0, 10)})` : ""}`);

  const channel = channelId();
  const slack = await postSlackMessage(main.join("\n"), channel);
  if (!slack.ok) return { report: r, alerted: false, slackReason: slack.reason };

  let threadReason: string | undefined;
  if (acted && slack.ts) {
    const lines: string[] = [];
    for (const c of r.byClient) {
      lines.push(`• *${c.clientTag}* (${c.instance}): removed ${c.removed} · tagged ${c.tagged} · attached ${c.attached} · redirects ${c.redirects}${c.errors ? ` · ⚠️ errors ${c.errors}` : ""}`);
    }
    for (const e of r.errors) {
      lines.push(`⚠️ ${e.at.slice(11, 16)} ${e.clientTag ?? "—"} ${e.domain ?? ""}: ${e.detail ?? "error"}`);
    }
    for (let i = 0; i < lines.length; i += CHUNK_LINES) {
      const reply = await postSlackMessage(lines.slice(i, i + CHUNK_LINES).join("\n"), channel, { threadTs: slack.ts });
      if (!reply.ok) { threadReason = `thread reply failed: ${reply.reason}`; break; }
    }
  }
  return { report: r, alerted: true, slackReason: threadReason };
}
