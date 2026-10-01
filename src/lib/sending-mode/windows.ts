// Turbo + throttle windows: open one, apply the limits, put everything back.
//
// A window is the unit of the spec's log: one row in sending_windows plus one
// row per account in sending_window_accounts holding the limits that account
// had BEFORE we touched it. Revert restores exactly those recorded values —
// never a hardcoded "normal" — so an operator's custom 10/day survives a
// Turbo window intact.
//
//   turbo     warm-up → turboWarmupLimit (5), daily → turboDailyLimit (8), for turboDays
//   throttle  daily → throttleDailyLimit (3); warm-up untouched
//
// Every path out (expiry, Cancel click, churn, pause, inactive, throttle
// release) goes through endWindow → the same revert routine. Apply and revert
// are both resumable: each account row carries applied/reverted/verified
// flags, so a run that hits the time budget leaves the window in
// 'applying' / 'reverting' and the hourly cron finishes it. A revert that
// still has failures after MAX_REVERT_ATTEMPTS is marked revert_failed and
// alerted — it is never silently dropped.
import { getSupabaseAdmin } from "@/lib/supabase";
import { BISON_INSTANCES, isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";
import { recordPipelineAlert, pipelineAlertChannel } from "@/lib/pipeline-alerts";
import { postSlackMessage } from "@/lib/slack";
import { getSendingModeSettings, type SendingModeSettings } from "./config";
import {
  listClientSenders,
  listClientWarmupLimits,
  resolveClientTagIds,
  setLimit,
  type ClientSender,
} from "./bison";

export type WindowKind = "turbo" | "throttle";
export type WindowStatus = "applying" | "active" | "reverting" | "ended" | "revert_failed";

export interface SendingWindow {
  id: string;
  client_tag: string;
  kind: WindowKind;
  status: WindowStatus;
  started_at: string;
  ends_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  activated_by: string | null;
  trigger_detail: string | null;
  status_at_start: string | null;
  pace_at_start: number | null;
  qls_at_start: number | null;
  sent_at_start: number | null;
  pace_at_end: number | null;
  qls_at_end: number | null;
  sent_at_end: number | null;
  account_count: number;
  applied_limits: { daily: number; warmup: number | null } | null;
  revert_attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface AccountRow {
  window_id: string;
  instance: string;
  inbox_id: number;
  email: string | null;
  domain: string | null;
  prev_daily_limit: number | null;
  prev_warmup_limit: number | null;
  applied: boolean;
  reverted: boolean;
  verified: boolean;
  last_error: string | null;
}

export const MAX_REVERT_ATTEMPTS = 3;
const OPEN_STATUSES: WindowStatus[] = ["applying", "active", "reverting"];

const db = () => getSupabaseAdmin();
const nowIso = () => new Date().toISOString();

/** Slack is OFF until SENDING_MODE_SLACK_ENABLED=true is set in Vercel — the
 *  window log + pipeline_alerts rows are always written regardless. */
const slackEnabled = () => process.env.SENDING_MODE_SLACK_ENABLED === "true";

async function notify(text: string): Promise<void> {
  if (!slackEnabled()) return;
  try { await postSlackMessage(text, pipelineAlertChannel()); } catch { /* never fails the job */ }
}

// ── Reads ──────────────────────────────────────────────────────────────────

export async function getOpenWindow(clientTag: string, kind?: WindowKind): Promise<SendingWindow | null> {
  let q = db().from("sending_windows").select("*").eq("client_tag", clientTag).in("status", OPEN_STATUSES);
  if (kind) q = q.eq("kind", kind);
  const { data, error } = await q.order("started_at", { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  return (data?.[0] as SendingWindow) ?? null;
}

export async function listOpenWindows(): Promise<SendingWindow[]> {
  const { data, error } = await db().from("sending_windows").select("*").in("status", OPEN_STATUSES);
  if (error) throw new Error(error.message);
  return (data || []) as SendingWindow[];
}

export async function listWindows(limit = 500): Promise<SendingWindow[]> {
  const { data, error } = await db()
    .from("sending_windows").select("*").order("started_at", { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return (data || []) as SendingWindow[];
}

async function getWindow(id: string): Promise<SendingWindow> {
  const { data, error } = await db().from("sending_windows").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`window ${id} not found`);
  return data as SendingWindow;
}

async function getAccounts(windowId: string): Promise<AccountRow[]> {
  const rows: AccountRow[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await db()
      .from("sending_window_accounts").select("*").eq("window_id", windowId).range(off, off + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data || []) as AccountRow[]));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

async function patchWindow(id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await db().from("sending_windows").update({ ...patch, updated_at: nowIso() }).eq("id", id);
  if (error) throw new Error(error.message);
}

async function flagAccounts(windowId: string, instance: string, ids: number[], patch: Partial<AccountRow>): Promise<void> {
  for (let i = 0; i < ids.length; i += 500) {
    await db().from("sending_window_accounts").update(patch)
      .eq("window_id", windowId).eq("instance", instance).in("inbox_id", ids.slice(i, i + 500));
  }
}

/** Mirror the applied limit into deliverability_inboxes so the UI matches
 *  Bison without waiting for the next crawl. Best-effort. */
async function mirrorLimits(instance: string, ids: number[], field: "daily_limit" | "warmup_daily_limit", limit: number): Promise<void> {
  for (let i = 0; i < ids.length; i += 500) {
    await db().from("deliverability_inboxes").update({ [field]: limit })
      .eq("instance", instance).in("id", ids.slice(i, i + 500));
  }
}

// ── Account discovery ──────────────────────────────────────────────────────

export interface ClientAccounts {
  senders: ClientSender[];
  warmup: Map<string, number>;        // `${instance}:${id}` → warm-up limit
  tagIds: Map<BisonInstanceSlug, number>;
  emailsSent: number;
}

/** Live from Bison: every connected sender tagged with the client across the
 *  four instances, plus their warm-up limits when `withWarmup`. */
export async function loadClientAccounts(clientTag: string, withWarmup: boolean): Promise<ClientAccounts> {
  const tagIds = await resolveClientTagIds(clientTag);
  const senders: ClientSender[] = [];
  const warmup = new Map<string, number>();
  await Promise.all(
    [...tagIds].map(async ([instance, tagId]) => {
      const list = await listClientSenders(instance, tagId);
      senders.push(...list);
      if (withWarmup) {
        const w = await listClientWarmupLimits(instance, tagId);
        for (const [id, lim] of w) warmup.set(`${instance}:${id}`, lim);
      }
    }),
  );
  return { senders, warmup, tagIds, emailsSent: senders.reduce((s, x) => s + x.emailsSent, 0) };
}

// ── Open ───────────────────────────────────────────────────────────────────

export interface StartWindowInput {
  clientTag: string;
  kind: WindowKind;
  activatedBy: string;
  triggerDetail?: string;
  statusAtStart?: string | null;
  paceAtStart?: number | null;
  qlsAtStart?: number | null;
  budgetMs?: number;
}

export interface StartWindowResult {
  window: SendingWindow;
  accounts: number;
  applied: number;
  failed: number;
  finished: boolean;   // false → still 'applying', the cron continues it
}

/**
 * Open a window for a client: snapshot every account's current limits, then
 * apply the window's limits. One open window per client at a time — a turbo
 * and a throttle never overlap (the spec's "Turbo and throttle never apply at
 * the same time"); opening a turbo while throttled first releases the throttle.
 */
export async function startWindow(input: StartWindowInput): Promise<StartWindowResult> {
  const clientTag = input.clientTag.trim().toUpperCase();
  const settings = await getSendingModeSettings();

  const open = await getOpenWindow(clientTag);
  if (open) {
    if (open.kind === input.kind) throw new Error(`${clientTag} already has an active ${open.kind} window`);
    if (input.kind === "turbo" && open.kind === "throttle") {
      const r = await endWindow(open.id, "turbo_started", { budgetMs: input.budgetMs });
      if (!r.finished) throw new Error(`${clientTag}: releasing the throttle first — try again in a minute`);
    } else {
      throw new Error(`${clientTag} is in Turbo — the throttle never applies on top of it`);
    }
  }

  const accounts = await loadClientAccounts(clientTag, input.kind === "turbo");
  if (accounts.senders.length === 0) throw new Error(`${clientTag}: no connected sender accounts carry this tag on any instance`);

  const limits = {
    daily: input.kind === "turbo" ? settings.turboDailyLimit : settings.throttleDailyLimit,
    warmup: input.kind === "turbo" ? settings.turboWarmupLimit : null,
  };
  const startedAt = new Date();
  const endsAt = input.kind === "turbo" ? new Date(startedAt.getTime() + settings.turboDays * 86_400_000) : null;

  const { data: created, error } = await db().from("sending_windows").insert({
    client_tag: clientTag,
    kind: input.kind,
    status: "applying",
    started_at: startedAt.toISOString(),
    ends_at: endsAt ? endsAt.toISOString() : null,
    activated_by: input.activatedBy,
    trigger_detail: input.triggerDetail ?? null,
    status_at_start: input.statusAtStart ?? null,
    pace_at_start: input.paceAtStart ?? null,
    qls_at_start: input.qlsAtStart ?? null,
    sent_at_start: accounts.emailsSent,
    account_count: accounts.senders.length,
    applied_limits: limits,
  }).select("*").single();
  if (error || !created) throw new Error(error?.message || "could not create window");
  const window = created as SendingWindow;

  const rows = accounts.senders.map((s) => ({
    window_id: window.id,
    instance: s.instance,
    inbox_id: s.id,
    email: s.email,
    domain: s.domain,
    prev_daily_limit: s.dailyLimit,
    prev_warmup_limit: accounts.warmup.get(`${s.instance}:${s.id}`) ?? null,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error: e } = await db().from("sending_window_accounts").insert(rows.slice(i, i + 500));
    if (e) {
      await patchWindow(window.id, { status: "ended", ended_at: nowIso(), end_reason: "snapshot_failed", last_error: e.message });
      throw new Error(`snapshot failed: ${e.message}`);
    }
  }

  const r = await continueApply(window.id, input.budgetMs);
  return { window: await getWindow(window.id), accounts: rows.length, applied: r.applied, failed: r.failed, finished: r.finished };
}

/** Apply the window's limits to every account not yet applied. Resumable. */
export async function continueApply(windowId: string, budgetMs = 200_000): Promise<{ applied: number; failed: number; finished: boolean }> {
  const t0 = Date.now();
  const window = await getWindow(windowId);
  if (window.status !== "applying") return { applied: 0, failed: 0, finished: true };
  const limits = window.applied_limits ?? { daily: 5, warmup: null };
  const accounts = (await getAccounts(windowId)).filter((a) => !a.applied);

  let applied = 0, failed = 0;
  const byInstance = new Map<string, AccountRow[]>();
  for (const a of accounts) byInstance.set(a.instance, [...(byInstance.get(a.instance) ?? []), a]);

  let outOfTime = false;
  for (const [instance, list] of byInstance) {
    if (!isInstanceSlug(instance)) continue;
    if (Date.now() - t0 > budgetMs) { outOfTime = true; break; }
    const ids = list.map((a) => a.inbox_id);

    const daily = await setLimit(instance, "daily", ids, limits.daily);
    let okIds = daily.ok;
    if (limits.warmup !== null) {
      // Only accounts whose warm-up limit we could read get a warm-up change —
      // otherwise there's nothing to put back.
      const readable = new Set(list.filter((a) => a.prev_warmup_limit !== null).map((a) => a.inbox_id));
      const warm = await setLimit(instance, "warmup", okIds.filter((id) => readable.has(id)), limits.warmup);
      const warmFailed = new Set(warm.failed);
      okIds = okIds.filter((id) => !warmFailed.has(id));
      if (warm.ok.length) await mirrorLimits(instance, warm.ok, "warmup_daily_limit", limits.warmup);
      daily.failed.push(...warm.failed);
    }
    if (okIds.length) {
      await flagAccounts(windowId, instance, okIds, { applied: true, last_error: null });
      await mirrorLimits(instance, okIds, "daily_limit", limits.daily);
    }
    if (daily.failed.length) await flagAccounts(windowId, instance, daily.failed, { last_error: "Bison rejected the limit change" });
    applied += okIds.length;
    failed += daily.failed.length;
  }

  const finished = !outOfTime;
  if (finished) {
    await patchWindow(windowId, {
      status: "active",
      last_error: failed > 0 ? `${failed} account(s) did not take the ${window.kind} limits` : null,
    });
    if (window.kind === "turbo") {
      await notify(`:rocket: *Turbo on* — ${window.client_tag}: ${applied} account(s) → ${limits.warmup} warm-up / ${limits.daily} sending until ${window.ends_at?.slice(0, 10)}${failed ? ` · ${failed} failed` : ""}`);
    }
  }
  return { applied, failed, finished };
}

// ── Close ──────────────────────────────────────────────────────────────────

export interface EndWindowResult {
  reverted: number;
  failed: number;
  finished: boolean;      // false → still 'reverting', the cron retries
  status: WindowStatus;
}

/**
 * Put every account back to its recorded limits, verify, and close the
 * window. Safe to call repeatedly — only accounts not yet reverted are
 * touched. After MAX_REVERT_ATTEMPTS with failures left the window becomes
 * revert_failed and an alert is raised with the account list.
 */
export async function endWindow(
  windowId: string,
  reason: string,
  opts: { budgetMs?: number; paceAtEnd?: number | null; qlsAtEnd?: number | null } = {},
): Promise<EndWindowResult> {
  const t0 = Date.now();
  const budgetMs = opts.budgetMs ?? 200_000;
  const window = await getWindow(windowId);
  if (window.status === "ended") return { reverted: 0, failed: 0, finished: true, status: "ended" };

  const firstPass = window.status !== "reverting" && window.status !== "revert_failed";
  if (firstPass) {
    await patchWindow(windowId, {
      status: "reverting",
      end_reason: reason,
      pace_at_end: opts.paceAtEnd ?? null,
      qls_at_end: opts.qlsAtEnd ?? null,
    });
  }
  await patchWindow(windowId, { revert_attempts: (window.revert_attempts ?? 0) + 1, status: "reverting" });

  // Accounts that were never applied have nothing to revert.
  const pending = (await getAccounts(windowId)).filter((a) => a.applied && !a.reverted);
  const byInstance = new Map<string, AccountRow[]>();
  for (const a of pending) byInstance.set(a.instance, [...(byInstance.get(a.instance) ?? []), a]);

  let reverted = 0, failed = 0, outOfTime = false;
  const failedList: string[] = [];
  for (const [instance, list] of byInstance) {
    if (!isInstanceSlug(instance)) continue;
    if (Date.now() - t0 > budgetMs) { outOfTime = true; break; }

    // Group by the value we're restoring — a bulk PATCH takes one limit.
    const byDaily = new Map<number, number[]>();
    const byWarm = new Map<number, number[]>();
    for (const a of list) {
      const d = a.prev_daily_limit ?? 5;
      byDaily.set(d, [...(byDaily.get(d) ?? []), a.inbox_id]);
      if (window.kind === "turbo" && a.prev_warmup_limit !== null) {
        byWarm.set(a.prev_warmup_limit, [...(byWarm.get(a.prev_warmup_limit) ?? []), a.inbox_id]);
      }
    }
    const failedIds = new Set<number>();
    for (const [limit, ids] of byDaily) {
      const r = await setLimit(instance, "daily", ids, limit);
      r.failed.forEach((id) => failedIds.add(id));
      if (r.ok.length) await mirrorLimits(instance, r.ok, "daily_limit", limit);
    }
    for (const [limit, ids] of byWarm) {
      const r = await setLimit(instance, "warmup", ids, limit);
      r.failed.forEach((id) => failedIds.add(id));
      if (r.ok.length) await mirrorLimits(instance, r.ok, "warmup_daily_limit", limit);
    }

    // Verify: re-read the client's senders and compare daily limits. Warm-up
    // is checked the same way when the window changed it.
    const tagIds = await resolveClientTagIds(window.client_tag);
    const tagId = tagIds.get(instance);
    const okIds = list.map((a) => a.inbox_id).filter((id) => !failedIds.has(id));
    let verifiedIds = okIds;
    if (tagId !== undefined) {
      try {
        const live = new Map((await listClientSenders(instance, tagId)).map((s) => [s.id, s.dailyLimit]));
        const liveWarm = window.kind === "turbo" ? await listClientWarmupLimits(instance, tagId) : new Map<number, number>();
        const want = new Map(list.map((a) => [a.inbox_id, a]));
        verifiedIds = okIds.filter((id) => {
          const a = want.get(id)!;
          const d = live.get(id);
          // A sender that no longer carries the tag / was deleted can't be
          // verified — count it reverted (removed cleanly, per the spec).
          if (d === undefined) return true;
          if (d !== (a.prev_daily_limit ?? d)) return false;
          if (window.kind === "turbo" && a.prev_warmup_limit !== null) {
            const w = liveWarm.get(id);
            if (w !== undefined && w !== a.prev_warmup_limit) return false;
          }
          return true;
        });
      } catch {
        verifiedIds = []; // couldn't verify → leave for the next attempt
      }
    }
    const verifiedSet = new Set(verifiedIds);
    const unverified = okIds.filter((id) => !verifiedSet.has(id));
    if (verifiedIds.length) await flagAccounts(windowId, instance, verifiedIds, { reverted: true, verified: true, last_error: null });
    if (unverified.length) await flagAccounts(windowId, instance, unverified, { last_error: "limit did not read back as restored" });
    if (failedIds.size) await flagAccounts(windowId, instance, [...failedIds], { last_error: "Bison rejected the restore" });
    reverted += verifiedIds.length;
    failed += unverified.length + failedIds.size;
    for (const a of list) {
      if (!verifiedSet.has(a.inbox_id)) failedList.push(`${a.email ?? a.inbox_id} (${BISON_INSTANCES[instance].label})`);
    }
  }

  if (outOfTime) return { reverted, failed, finished: false, status: "reverting" };

  const attempts = (window.revert_attempts ?? 0) + 1;
  if (failed === 0) {
    const sentAtEnd = await currentEmailsSent(window.client_tag);
    await patchWindow(windowId, { status: "ended", ended_at: nowIso(), sent_at_end: sentAtEnd, last_error: null });
    await notify(
      window.kind === "turbo"
        ? `:white_check_mark: *Turbo off* — ${window.client_tag}: ${reverted} account(s) restored (${reason})`
        : `:white_check_mark: *Throttle released* — ${window.client_tag}: ${reverted} account(s) restored (${reason})`,
    );
    return { reverted, failed, finished: true, status: "ended" };
  }

  if (attempts >= MAX_REVERT_ATTEMPTS) {
    await patchWindow(windowId, { status: "revert_failed", last_error: `${failed} account(s) not restored after ${attempts} attempts` });
    const list = failedList.slice(0, 40).join(", ") + (failedList.length > 40 ? ` … +${failedList.length - 40} more` : "");
    await recordPipelineAlert({
      source: "sending-mode",
      clientTag: window.client_tag,
      step: `${window.kind}-revert`,
      reason: `${failed} account(s) did not restore after ${attempts} attempts: ${list}`,
      silent: true,
    });
    await notify(`:rotating_light: *${window.kind} revert failed* — ${window.client_tag}: ${failed} account(s) still on window limits after ${attempts} tries\n${list}`);
    return { reverted, failed, finished: true, status: "revert_failed" };
  }

  await patchWindow(windowId, { last_error: `${failed} account(s) not yet restored (attempt ${attempts})` });
  return { reverted, failed, finished: false, status: "reverting" };
}

async function currentEmailsSent(clientTag: string): Promise<number | null> {
  try {
    const a = await loadClientAccounts(clientTag, false);
    return a.emailsSent;
  } catch {
    return null;
  }
}

/** Client tags with an open window — limit-policy skips these so its daily
 *  3/5 ladder doesn't undo a throttle or a Turbo overnight. */
export async function clientsWithOpenWindows(): Promise<Set<string>> {
  try {
    const open = await listOpenWindows();
    return new Set(open.map((w) => w.client_tag.toUpperCase()));
  } catch {
    return new Set();
  }
}

export type { SendingModeSettings };
