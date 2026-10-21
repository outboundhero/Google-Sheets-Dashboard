// Per-client QL pace + the auto-throttle decision.
//
// evaluateAllClients() builds the row the Performance tab shows for each
// active, tiered client (billing period, guarantee + target, MRLs, QL rate,
// QLs, pace, projected, status, leaving) and writes it to
// client_sending_status. The throttle pass reads those rows and opens/releases
// throttle windows per the spec:
//
//   on   status Overperforming (forecast ≥ 150% of the guarantee with enough
//        data — new clients included, see ql-pace.ts), client not in Turbo,
//        not leaving, auto-throttle not paused for them, and still projected
//        to reach the operational target once throttled
//   off  new billing period · forecast < target
//        (a throttle must never cost the client its target) · client now
//        leaving / in Turbo / paused
//
// Inputs are the stores the MRL pacing cron already uses: leads-store Redis +
// the Client Tracker (tier → QL guarantee, Start Date → billing anchor,
// churn/pause dates → leaving).
import { getStoredLeadsWithFreshness } from "@/lib/leads-store";
import { getClientTrackerData } from "@/lib/google-sheets";
import { getClientTierMap, resolveTier, TARGETS } from "@/lib/cron/client-reports";
import { getSupabaseAdmin } from "@/lib/supabase";
import { pstDateString } from "@/lib/date-utils";
import type { Lead } from "@/types/lead";
import {
  evaluateQlPace, lastStatusCutoff, NORMAL_DAILY_LIMIT, operationalTarget, projectedIfThrottled,
  type QlPace, type QlPaceStatus,
} from "./ql-pace";
import { getSendingModeSettings, type SendingModeSettings } from "./config";
import { endWindow, listOpenWindows, startWindow, type SendingWindow } from "./windows";
import { sendCapacity } from "./capacity";


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
  const [{ leads, syncedAtByClient }, tracker, tierMap] = await Promise.all([getStoredLeadsWithFreshness(), getClientTrackerData(), getClientTierMap()]);
  // Sheet tags carry suffixes ("CCGDA: Leads") — key by the client tag, stalest sheet wins.
  const syncedAt = new Map<string, string>();
  for (const [sheetTag, at] of Object.entries(syncedAtByClient)) {
    const tag = sheetTag.split(":")[0].trim().toUpperCase();
    const prev = syncedAt.get(tag);
    if (!prev || at < prev) syncedAt.set(tag, at);
  }

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
      syncedAt: syncedAt.get(clientTag) ?? null,
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

// Performance v2 columns (supabase-sending-mode.sql). Until they exist the
// save falls back to the original columns so the hourly job keeps running.
const V2_MISSING = /column|schema cache|type integer/i;

export async function saveClientStatuses(rows: ClientSendingStatus[]): Promise<void> {
  const supabase = getSupabaseAdmin();
  const nowIso = new Date().toISOString();
  const live = rows.filter((r) => r.gone === null);
  const base = live.map((r) => ({
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
    projected: Math.round(r.projected),
    status: r.status,
    leaving_on: r.leavingOn,
    leaving_kind: r.leavingKind,
    tracker_status: r.trackerStatus,
    evaluated_at: nowIso,
  }));
  const full = live.map((r, i) => ({
    ...base[i],
    projected: r.projected,
    target: r.target,
    mrls_delivered: r.mrlsDelivered,
    mrls_pending: r.mrlsPending,
    qls_30d: r.qls30d,
    nqls_30d: r.nqls30d,
    dups_30d: r.dups30d,
    actual_rate: r.actualRate,
    blended_rate: r.blendedRate,
    mrl_pace: r.mrlPace,
    mrls_needed: r.mrlsNeeded,
    last_status_at: r.lastStatusAt,
  }));
  let v2 = true;
  for (let i = 0; i < live.length; i += 500) {
    const upsert = (batch: object[]) => supabase.from("client_sending_status").upsert(batch, { onConflict: "client_tag" });
    let { error } = v2 ? await upsert(full.slice(i, i + 500)) : await upsert(base.slice(i, i + 500));
    if (error && v2 && V2_MISSING.test(error.message)) {
      v2 = false;
      ({ error } = await upsert(base.slice(i, i + 500)));
    }
    if (error) throw new Error(`client_sending_status upsert: ${error.message}`);
  }
  const keep = new Set(live.map((r) => r.clientTag));
  const { data: existing } = await supabase.from("client_sending_status").select("client_tag");
  const stale = ((existing || []) as { client_tag: string }[]).map((r) => r.client_tag).filter((t) => !keep.has(t));
  if (stale.length) await supabase.from("client_sending_status").delete().in("client_tag", stale);
}

/** A stored client_sending_status row back as a ClientSendingStatus. Rows
 *  written before the v2 columns existed read as zero / the prior rate. */
export function statusFromRow(r: Record<string, unknown>): ClientSendingStatus {
  const n = (v: unknown, fallback = 0) => (v === null || v === undefined ? fallback : Number(v));
  const guarantee = Number(r.guarantee);
  return {
    clientTag: String(r.client_tag).toUpperCase(),
    companyName: (r.company_name as string | null) ?? "",
    plan: (r.plan as string | null) ?? "",
    trackerStatus: (r.tracker_status as string | null) ?? "",
    leavingOn: (r.leaving_on as string | null) ?? null,
    leavingKind: (r.leaving_kind as "churn" | "pause" | null) ?? null,
    gone: null,
    guarantee,
    target: n(r.target, operationalTarget(guarantee)),
    cycleStart: String(r.cycle_start),
    cycleEnd: String(r.cycle_end),
    cycleLength: Number(r.cycle_length),
    daysElapsed: Number(r.days_elapsed),
    daysRemaining: Number(r.days_remaining),
    mrlsDelivered: n(r.mrls_delivered),
    mrlsPending: n(r.mrls_pending),
    qlsDelivered: Number(r.qls_delivered),
    qls30d: n(r.qls_30d),
    nqls30d: n(r.nqls_30d),
    dups30d: n(r.dups_30d),
    actualRate: r.actual_rate === null || r.actual_rate === undefined ? null : Number(r.actual_rate),
    blendedRate: n(r.blended_rate),
    mrlPace: n(r.mrl_pace),
    mrlsNeeded: r.mrls_needed === null || r.mrls_needed === undefined ? null : Number(r.mrls_needed),
    projected: n(r.projected),
    expectedToDate: Number(r.expected_to_date),
    pace: r.pace === null || r.pace === undefined ? null : Number(r.pace),
    status: String(r.status) as QlPaceStatus,
    lastStatusAt: (r.last_status_at as string | null) ?? null,
    judgedAt: lastStatusCutoff(new Date(String(r.evaluated_at))).toISOString(),
    repliesToDate: 0,
    blankStatusToDate: 0,
  };
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
      else if (r.projected < r.target) out.push({ ...base, action: "release", reason: "below_target" });
      else if (paused.has(r.clientTag)) out.push({ ...base, action: "release", reason: "auto_throttle_paused" });
      else out.push({ ...base, action: "none", reason: `throttled, forecast ${r.projected}` });
      continue;
    }
    if (w) { out.push({ ...base, action: "none", reason: "in turbo" }); continue; }
    if (r.gone || r.leavingOn) { out.push({ ...base, action: "none", reason: r.gone ?? `leaving ${r.leavingOn}` }); continue; }
    if (paused.has(r.clientTag)) { out.push({ ...base, action: "none", reason: "auto-throttle paused" }); continue; }
    if (r.status === "overperforming") {
      const after = projectedIfThrottled(r, keepRatio.get(r.clientTag) ?? s.throttleDailyLimit / NORMAL_DAILY_LIMIT);
      if (after < r.target) {
        out.push({ ...base, action: "none", projectedIfThrottled: after, reason: `would drop under target (≈${after} of ${r.target})` });
      } else {
        out.push({ ...base, action: "throttle", projectedIfThrottled: after, reason: `forecast ${r.projected} ≥ ${r.guarantee * s.throttleAtGuarantee} (${Math.round(s.throttleAtGuarantee * 100)}% of ${r.guarantee})` });
      }
    } else out.push({ ...base, action: "none", reason: `forecast ${r.projected}` });
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
  /** allowNew false (switch off): releases still run — a throttle opened
   *  while the switch was on must still come off — but nobody new is throttled. */
  opts: { dry?: boolean; allowNew?: boolean; budgetMs?: number; deadline?: number } = {},
): Promise<ThrottlePassResult> {
  const [open, paused] = await Promise.all([listOpenWindows(), getThrottlePausedSet()]);
  const decisions = await decideThrottlesWithCapacity(rows, open, paused, s);
  const result: ThrottlePassResult = { throttled: [], released: [], errors: [], decisions };
  if (opts.dry) return result;

  const byTag = new Map(rows.map((r) => [r.clientTag, r]));
  const openByTag = new Map(open.map((w) => [w.client_tag.toUpperCase(), w]));
  for (const d of decisions) {
    if (d.action === "none") continue;
    if (d.action === "throttle" && opts.allowNew === false) continue;
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
