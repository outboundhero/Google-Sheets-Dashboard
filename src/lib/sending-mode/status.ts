// Per-client QL pace + the auto-throttle decision.
//
// evaluateAllClients() builds the row the Performance tab shows for each
// active, tiered client (billing period, guarantee, QLs, pace, projected,
// status, leaving) and writes it to client_sending_status. The throttle pass
// reads those rows and opens/releases throttle windows per the spec:
//
//   on   pace ≥ throttleOnPace after the grace days, client not in Turbo,
//        not leaving, auto-throttle not paused for them
//   off  pace < throttleOffPace · new billing period · projected < guarantee
//        (a throttle must never put the guarantee at risk) · client now
//        leaving / in Turbo / paused
//
// Inputs are the stores the MRL pacing cron already uses: leads-store Redis +
// the Client Tracker (tier → QL guarantee, Start Date → billing anchor,
// churn/pause dates → leaving).
import { getStoredLeads } from "@/lib/leads-store";
import { getClientTrackerData } from "@/lib/google-sheets";
import { getClientTierMap, resolveTier, TARGETS } from "@/lib/cron/client-reports";
import { getSupabaseAdmin } from "@/lib/supabase";
import { pstDateString } from "@/lib/date-utils";
import type { Lead } from "@/types/lead";
import { evaluateQlPace, type QlPace, type QlPaceStatus } from "./ql-pace";
import { getSendingModeSettings, type SendingModeSettings } from "./config";
import { endWindow, listOpenWindows, startWindow, type SendingWindow } from "./windows";
import { sendCapacity } from "./capacity";

// What an assigned account normally sends (limit-policy ASSIGNED_LIMIT) — the
// fallback for the under-target check when real capacity is unknown.
const NORMAL_DAILY_LIMIT = 5;

export interface ClientSendingStatus extends QlPace {
  clientTag: string;
  companyName: string;
  plan: string;
  trackerStatus: string;
  leavingOn: string | null;      // yyyy-mm-dd
  leavingKind: "churn" | "pause" | null;
  gone: "churned" | "paused" | "inactive" | null;   // already off → windows must close
}

function tagCandidates(clientTag: string): Set<string> {
  const out = new Set<string>();
  for (const base of [clientTag, clientTag.split(":")[0]]) {
    const whole = base.trim().toUpperCase();
    if (whole) out.add(whole);
    for (const slash of base.split("/")) {
      for (const amp of slash.split(" & ")) {
        const v = amp.trim().toUpperCase();
        if (v) out.add(v);
      }
    }
  }
  return out;
}

function sheetDate(cell: string | null | undefined): string | null {
  const m = String(cell || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  const d = cell ? new Date(cell) : null;
  return d && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

/** Every active, tiered client with a billing anchor — same gate MRL pacing uses. */
export async function evaluateAllClients(settings?: SendingModeSettings, now = new Date()): Promise<ClientSendingStatus[]> {
  const s = settings ?? (await getSendingModeSettings());
  const [leads, tracker, tierMap] = await Promise.all([getStoredLeads(), getClientTrackerData(), getClientTierMap()]);

  // One row per client tag (Spencer 2026-10-10: "each client tag is judged
  // independently"). A sheet tagged "CCGDA: Leads" is CCGDA — the suffix isn't
  // part of the Bison tag, so keeping it also broke Turbo's account lookup. An
  // old combined sheet ("CVJLEX / CVJLOU / CVJORL") is dropped when every tag
  // in it has its own sheet; otherwise it's the only source and stays.
  const leadsByTag = new Map<string, Lead[]>();
  for (const lead of leads) {
    const tag = (lead.sheetClientTag || lead.clientTag || "").split(":")[0].trim().toUpperCase();
    if (!tag) continue;
    leadsByTag.set(tag, [...(leadsByTag.get(tag) ?? []), lead]);
  }
  for (const tag of [...leadsByTag.keys()]) {
    const parts = tag.split("/").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1 && parts.every((p) => leadsByTag.has(p))) leadsByTag.delete(tag);
  }
  const trackerByAbbr = new Map<string, (typeof tracker)[number]>();
  for (const row of tracker) {
    for (const cand of tagCandidates(row.clientAbbr)) if (!trackerByAbbr.has(cand)) trackerByAbbr.set(cand, row);
  }

  const today = pstDateString(now);
  const out: ClientSendingStatus[] = [];
  for (const [clientTag, clientLeads] of leadsByTag) {
    const tier = resolveTier(clientTag, tierMap);
    if (!tier || !tier.bucket) continue;
    let trackerRow: (typeof tracker)[number] | undefined;
    for (const cand of tagCandidates(clientTag)) { trackerRow = trackerByAbbr.get(cand); if (trackerRow) break; }
    const anchorStr = trackerRow?.startDate || trackerRow?.goLiveDate;
    const anchor = anchorStr ? new Date(anchorStr) : null;
    if (!anchor || isNaN(anchor.getTime()) || anchor > now) continue;

    const churn = sheetDate(trackerRow?.churnDate ?? tier.churnDate);
    const pause = sheetDate(trackerRow?.pauseDate);
    const active = /active/i.test(tier.status);
    const gone: ClientSendingStatus["gone"] =
      churn && churn <= today ? "churned"
      : pause && pause <= today ? "paused"
      : !active ? "inactive"
      : null;
    // Inactive clients are excluded from the tab, but still returned flagged
    // so an open window on them gets closed.
    const leaving = churn && churn > today ? { on: churn, kind: "churn" as const }
      : pause && pause > today ? { on: pause, kind: "pause" as const }
      : null;

    const pace = evaluateQlPace({
      guarantee: TARGETS[tier.bucket].qlMonthly,
      cycleAnchor: anchor,
      leads: clientLeads,
      settings: s,
      now,
    });
    out.push({
      ...pace,
      clientTag,
      companyName: trackerRow?.companyName || clientTag,
      plan: tier.plan,
      trackerStatus: tier.status,
      leavingOn: leaving?.on ?? null,
      leavingKind: leaving?.kind ?? null,
      gone,
    });
  }
  return out;
}

export async function saveClientStatuses(rows: ClientSendingStatus[]): Promise<void> {
  const supabase = getSupabaseAdmin();
  const nowIso = new Date().toISOString();
  const live = rows.filter((r) => r.gone === null);
  const upserts = live.map((r) => ({
    client_tag: r.clientTag,
    company_name: r.companyName,
    plan: r.plan,
    guarantee: r.guarantee,
    cycle_start: r.cycleStart,
    cycle_end: r.cycleEnd,
    cycle_length: r.cycleLength,
    days_elapsed: r.daysElapsed,
    days_remaining: r.daysRemaining,
    qls_delivered: r.qlsDelivered,
    expected_to_date: r.expectedToDate,
    pace: r.pace,
    projected: r.projected,
    status: r.status,
    leaving_on: r.leavingOn,
    leaving_kind: r.leavingKind,
    tracker_status: r.trackerStatus,
    evaluated_at: nowIso,
  }));
  for (let i = 0; i < upserts.length; i += 500) {
    const { error } = await supabase.from("client_sending_status").upsert(upserts.slice(i, i + 500), { onConflict: "client_tag" });
    if (error) throw new Error(`client_sending_status upsert: ${error.message}`);
  }
  const keep = new Set(live.map((r) => r.clientTag));
  const { data: existing } = await supabase.from("client_sending_status").select("client_tag");
  const stale = ((existing || []) as { client_tag: string }[]).map((r) => r.client_tag).filter((t) => !keep.has(t));
  if (stale.length) await supabase.from("client_sending_status").delete().in("client_tag", stale);
}

export async function getThrottlePausedSet(): Promise<Set<string>> {
  const { data } = await getSupabaseAdmin().from("client_sending_prefs").select("client_tag, auto_throttle_paused").eq("auto_throttle_paused", true);
  return new Set(((data || []) as { client_tag: string }[]).map((r) => r.client_tag.toUpperCase()));
}

export interface ThrottleDecision {
  clientTag: string;
  action: "throttle" | "release" | "none";
  reason: string;
  pace: number | null;
  status: QlPaceStatus;
  /** Throttle candidates: projected QLs if throttled to the period's end. */
  projectedIfThrottled?: number;
}

/**
 * Projected QLs at the end of the period if the client sends only `keepRatio`
 * of today's volume from now on: QLs already delivered stay; the rest of the
 * projection shrinks with sending. Used for "never throttle a client under
 * target" (Vicky 2026-10-09 — the first preview had SBTB going 16 → ~7 on a
 * 10 target, and the release rule would only notice after the QLs were lost).
 */
export function projectedIfThrottled(r: Pick<ClientSendingStatus, "qlsDelivered" | "projected">, keepRatio: number): number {
  return Math.round(r.qlsDelivered + Math.max(0, r.projected - r.qlsDelivered) * keepRatio);
}

/** Pure: what the throttle pass would do for each client. `keepRatio` per tag
 *  (from capacity.ts) feeds the under-target check; a missing tag falls back
 *  to throttle ÷ the normal 5/day. */
export function decideThrottles(
  rows: ClientSendingStatus[],
  open: SendingWindow[],
  paused: Set<string>,
  s: SendingModeSettings,
  keepRatio: Map<string, number> = new Map(),
): ThrottleDecision[] {
  const openByTag = new Map<string, SendingWindow>();
  for (const w of open) openByTag.set(w.client_tag.toUpperCase(), w);
  const out: ThrottleDecision[] = [];
  for (const r of rows) {
    const w = openByTag.get(r.clientTag);
    const base = { clientTag: r.clientTag, pace: r.pace, status: r.status };
    if (w?.kind === "throttle") {
      if (r.gone) out.push({ ...base, action: "release", reason: r.gone });
      else if (r.leavingOn) out.push({ ...base, action: "release", reason: `leaving ${r.leavingOn}` });
      else if (w.started_at.slice(0, 10) < r.cycleStart) out.push({ ...base, action: "release", reason: "new_period" });
      else if (r.projected < r.guarantee) out.push({ ...base, action: "release", reason: "guarantee_at_risk" });
      else if (r.pace !== null && r.pace < s.throttleOffPace) out.push({ ...base, action: "release", reason: "pace_below_off" });
      else if (paused.has(r.clientTag)) out.push({ ...base, action: "release", reason: "auto_throttle_paused" });
      else out.push({ ...base, action: "none", reason: `throttled, pace ${r.pace}` });
      continue;
    }
    if (w) { out.push({ ...base, action: "none", reason: "in turbo" }); continue; }
    if (r.gone || r.leavingOn) { out.push({ ...base, action: "none", reason: r.gone ?? `leaving ${r.leavingOn}` }); continue; }
    if (paused.has(r.clientTag)) { out.push({ ...base, action: "none", reason: "auto-throttle paused" }); continue; }
    if (r.status === "grace") { out.push({ ...base, action: "none", reason: "grace period" }); continue; }
    if (r.status === "no_data") { out.push({ ...base, action: "none", reason: "no status data" }); continue; }
    if (r.pace !== null && r.pace >= s.throttleOnPace && r.projected >= r.guarantee) {
      const after = projectedIfThrottled(r, keepRatio.get(r.clientTag) ?? s.throttleDailyLimit / NORMAL_DAILY_LIMIT);
      if (after < r.guarantee) {
        out.push({ ...base, action: "none", projectedIfThrottled: after, reason: `would drop under target (≈${after} of ${r.guarantee})` });
      } else {
        out.push({ ...base, action: "throttle", projectedIfThrottled: after, reason: `pace ${Math.round(r.pace * 100)}% ≥ ${Math.round(s.throttleOnPace * 100)}%` });
      }
    } else out.push({ ...base, action: "none", reason: `pace ${r.pace ?? "—"}` });
  }
  return out;
}

/** decideThrottles with each candidate's real send capacity behind the
 *  under-target check — what both the pass and its preview run. */
export async function decideThrottlesWithCapacity(
  rows: ClientSendingStatus[],
  open: SendingWindow[],
  paused: Set<string>,
  s: SendingModeSettings,
): Promise<ThrottleDecision[]> {
  const first = decideThrottles(rows, open, paused, s);
  const candidates = first.filter((d) => d.projectedIfThrottled !== undefined).map((d) => d.clientTag);
  if (candidates.length === 0) return first;
  const cap = await sendCapacity(candidates, s.throttleDailyLimit);
  return decideThrottles(rows, open, paused, s, new Map([...cap].map(([t, c]) => [t, c.keepRatio])));
}

export interface ThrottlePassResult {
  throttled: { clientTag: string; accounts: number; failed: number }[];
  released: { clientTag: string; reverted: number; failed: number; reason: string }[];
  errors: { clientTag: string; error: string }[];
  decisions: ThrottleDecision[];
}

/** Execute the throttle decisions (or just report them when `dry`). */
export async function runThrottlePass(
  rows: ClientSendingStatus[],
  s: SendingModeSettings,
  opts: { dry?: boolean; budgetMs?: number; deadline?: number } = {},
): Promise<ThrottlePassResult> {
  const [open, paused] = await Promise.all([listOpenWindows(), getThrottlePausedSet()]);
  const decisions = await decideThrottlesWithCapacity(rows, open, paused, s);
  const result: ThrottlePassResult = { throttled: [], released: [], errors: [], decisions };
  if (opts.dry) return result;

  const byTag = new Map(rows.map((r) => [r.clientTag, r]));
  const openByTag = new Map(open.map((w) => [w.client_tag.toUpperCase(), w]));
  for (const d of decisions) {
    if (d.action === "none") continue;
    if (opts.deadline && Date.now() > opts.deadline) break;
    const r = byTag.get(d.clientTag)!;
    try {
      if (d.action === "release") {
        const w = openByTag.get(d.clientTag)!;
        const e = await endWindow(w.id, d.reason, { budgetMs: opts.budgetMs, paceAtEnd: r.pace, qlsAtEnd: r.qlsDelivered });
        result.released.push({ clientTag: d.clientTag, reverted: e.reverted, failed: e.failed, reason: d.reason });
      } else {
        const st = await startWindow({
          clientTag: d.clientTag,
          kind: "throttle",
          activatedBy: "auto-throttle",
          triggerDetail: d.reason,
          statusAtStart: r.status,
          paceAtStart: r.pace,
          qlsAtStart: r.qlsDelivered,
          budgetMs: opts.budgetMs,
        });
        result.throttled.push({ clientTag: d.clientTag, accounts: st.accounts, failed: st.failed });
      }
    } catch (e) {
      result.errors.push({ clientTag: d.clientTag, error: e instanceof Error ? e.message : "failed" });
    }
  }
  return result;
}
