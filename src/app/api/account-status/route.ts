import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { ALL_INSTANCE_SLUGS, type BisonInstanceSlug } from "@/lib/bison-instances";
import { bisonFetch } from "@/lib/bison";

export const maxDuration = 120;

/**
 * GET /api/account-status?date=YYYY-MM-DD
 *
 * Returns the daily disconnect / reconnect / failed report for a single
 * PST day (defaults to today PST). Aggregates across all 4 Bison instances
 * with a per-instance breakdown.
 *
 * Data sources:
 *   - disconnect_events     — every disconnection caught by the webhook
 *   - reconnect_tag_log     — every reconnection handled by the webhook (status='ok')
 *
 * Matching rule for "reconnected on the same day":
 *   reconnect_tag_log row exists with (instance, sender_id) and
 *   occurred_at >= disconnect.detected_at and occurred_at < end of that PST day.
 *
 * Anything disconnected on the day that doesn't have a matching reconnect → "failed".
 */

const PST_OFFSET_MS = 8 * 60 * 60 * 1000; // PST = UTC-8, no DST (per CLAUDE.md convention)

/** Returns today's PST date string (YYYY-MM-DD). */
function todayPstDateString(): string {
  const now = Date.now();
  const pst = new Date(now - PST_OFFSET_MS);
  return pst.toISOString().slice(0, 10);
}

/** Given a PST date string (YYYY-MM-DD), return [startUtc, endUtcExclusive] ISO strings. */
function pstDayRange(pstDate: string): [string, string] {
  const start = new Date(`${pstDate}T00:00:00-08:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return [start.toISOString(), end.toISOString()];
}

interface DisconnectRow {
  id: number;
  instance: BisonInstanceSlug;
  sender_id: number;
  sender_email: string | null;
  sender_name: string | null;
  detected_at: string;
}

interface ReconnectRow {
  id: number;
  instance: string;
  sender_id: number;
  sender_email: string | null;
  status: string;
  occurred_at: string;
}

export interface AccountEvent {
  instance: BisonInstanceSlug;
  sender_id: number;
  sender_email: string | null;
  sender_name: string | null;
  detected_at: string;
  reconnected_at?: string;
  /** How we determined this account was reconnected — only set on reconnected entries.
   *   - "webhook": reconnect_tag_log entry from /api/webhooks/bison-reconnect
   *   - "current_status": cached Bison status (deliverability_inboxes.status) no longer
   *     reads as disconnected — used when the reconnect webhook didn't fire or was lost
   *   - "live_bison": verified by hitting Bison's /sender-emails/{id} directly — the
   *     most authoritative source. Only set when ?verify=1 is passed.
   */
  reconnect_source?: "webhook" | "current_status" | "live_bison";
}

export interface AccountStatusReport {
  date: string;
  totals: { disconnected: number; reconnected: number; failed: number };
  perInstance: { instance: BisonInstanceSlug; disconnected: number; reconnected: number; failed: number }[];
  disconnectedAccounts: AccountEvent[];
  reconnectedAccounts: AccountEvent[];
  failedAccounts: AccountEvent[];
  /** Counts how the reconnects were classified — useful for surfacing in the UI */
  reconnectSources: { webhook: number; current_status: number; live_bison: number };
  /** True if ?verify=1 was passed and we live-checked the failed accounts against Bison */
  liveVerified?: boolean;
}

/**
 * Live-check Bison for each (instance, sender_id) — returns the set of sender keys
 * whose current Bison status reads as a "disconnected"-like value. Anything not in
 * the returned set is treated as currently connected on Bison. Runs requests in
 * parallel within each instance, with a soft per-instance concurrency limit so we
 * don't blow through Bison's per-account rate limit.
 */
async function liveCheckBisonStatus(
  perInstance: Map<BisonInstanceSlug, number[]>,
): Promise<{ stillDisconnected: Set<string>; checked: Set<string> }> {
  const stillDisconnected = new Set<string>();
  const checked = new Set<string>();
  const CONCURRENCY = 8;

  for (const [inst, ids] of perInstance) {
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const batch = ids.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (id) => {
          const res = await bisonFetch(inst, `/sender-emails/${id}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = await res.json();
          const data = json.data ?? json;
          const status = (data?.status ?? "").toString().toLowerCase();
          return { id, status };
        }),
      );
      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        const id = batch[j];
        const key = `${inst}:${id}`;
        if (r.status === "fulfilled") {
          checked.add(key);
          if (looksDisconnected(r.value.status)) stillDisconnected.add(key);
        } else {
          // If Bison returns 404 the sender no longer exists on Bison — treat as not
          // currently disconnected (it can't be connected and not exist either, but
          // for our purposes anything we can't verify stays in Failed via "not checked").
          console.warn(`[account-status:liveCheck:${inst}] sender ${id} failed: ${r.reason}`);
        }
      }
    }
  }
  return { stillDisconnected, checked };
}

function looksDisconnected(status: string): boolean {
  return (
    status.includes("disconnect") ||
    status.includes("reconnection") ||
    status.includes("login failed") ||
    status.includes("auth failed")
  );
}

export async function buildAccountStatusReport(
  pstDate: string,
  options: { verify?: boolean } = {},
): Promise<AccountStatusReport> {
  const supabase = getSupabaseAdmin();
  const [startUtc, endUtc] = pstDayRange(pstDate);

  const { data: disconnects, error: dErr } = await supabase
    .from("disconnect_events")
    .select("id, instance, sender_id, sender_email, sender_name, detected_at")
    .gte("detected_at", startUtc)
    .lt("detected_at", endUtc)
    .order("detected_at", { ascending: true });
  if (dErr) throw new Error(`disconnect_events: ${dErr.message}`);

  // reconnect_tag_log is populated by the existing /api/webhooks/bison-reconnect
  // handler. If the table doesn't exist yet (or rows haven't been written), treat
  // reconnects as empty so the dashboard still renders — everything will just
  // show as "failed" until the table is created and reconnects start landing.
  const { data: reconnects, error: rErr } = await supabase
    .from("reconnect_tag_log")
    .select("id, instance, sender_id, sender_email, status, occurred_at")
    .eq("status", "ok")
    .gte("occurred_at", startUtc)
    .lt("occurred_at", endUtc)
    .order("occurred_at", { ascending: true });
  if (rErr) {
    console.warn(`[account-status] reconnect_tag_log unavailable: ${rErr.message} — treating reconnects as empty`);
  }

  // Index reconnects by (instance, sender_id) → earliest reconnect of the day.
  const reconnectByKey = new Map<string, ReconnectRow>();
  for (const r of (reconnects ?? []) as ReconnectRow[]) {
    const key = `${r.instance}:${r.sender_id}`;
    if (!reconnectByKey.has(key)) reconnectByKey.set(key, r);
  }

  // De-dupe disconnect_events by (instance, sender_id) within the day — if Bison
  // fired twice, the user only saw one disconnection. Earliest event wins.
  const disconnectByKey = new Map<string, DisconnectRow>();
  for (const d of (disconnects ?? []) as DisconnectRow[]) {
    const key = `${d.instance}:${d.sender_id}`;
    if (!disconnectByKey.has(key)) disconnectByKey.set(key, d);
  }

  // Cross-reference with the cached Bison status (deliverability_inboxes.status).
  // If a sender is currently disconnected on Bison, the cached status reads as
  // something containing "disconnect" / "reconnection required" / "login failed".
  // Anything else means Bison currently sees them as connected, even if our
  // reconnect webhook didn't fire (or fired before reconnect_tag_log existed).
  // Senders not found in the table at all (e.g. very new sender, not yet synced)
  // are NOT auto-reconnected — we only flip when we have evidence they're up.
  const senderIdsByInstance = new Map<string, number[]>();
  for (const d of disconnectByKey.values()) {
    const arr = senderIdsByInstance.get(d.instance);
    if (arr) arr.push(d.sender_id);
    else senderIdsByInstance.set(d.instance, [d.sender_id]);
  }

  const inboxStatusByKey = new Map<string, string>();
  for (const [inst, ids] of senderIdsByInstance) {
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { data, error: sErr } = await supabase
        .from("deliverability_inboxes")
        .select("id, status")
        .eq("instance", inst)
        .in("id", chunk);
      if (sErr) {
        console.warn(`[account-status] could not read deliverability_inboxes.status for ${inst}: ${sErr.message}`);
        continue;
      }
      for (const row of (data ?? []) as { id: number; status: string | null }[]) {
        inboxStatusByKey.set(`${inst}:${row.id}`, (row.status ?? "").toLowerCase());
      }
    }
  }

  // Optional live verification against Bison — authoritative but slower. Only
  // covers senders we'd otherwise drop into Failed (neither webhook nor cached
  // status confirmed them as reconnected).
  let liveStillDisconnected: Set<string> = new Set();
  let liveChecked: Set<string> = new Set();
  if (options.verify) {
    const needsCheck = new Map<BisonInstanceSlug, number[]>();
    for (const d of disconnectByKey.values()) {
      const key = `${d.instance}:${d.sender_id}`;
      const r = reconnectByKey.get(key);
      if (r && r.occurred_at >= d.detected_at) continue;
      const cachedStatus = inboxStatusByKey.get(key);
      if (cachedStatus !== undefined && !looksDisconnected(cachedStatus)) continue;
      const arr = needsCheck.get(d.instance);
      if (arr) arr.push(d.sender_id);
      else needsCheck.set(d.instance, [d.sender_id]);
    }
    const res = await liveCheckBisonStatus(needsCheck);
    liveStillDisconnected = res.stillDisconnected;
    liveChecked = res.checked;
  }

  const disconnectedAccounts: AccountEvent[] = [];
  const reconnectedAccounts: AccountEvent[] = [];
  const failedAccounts: AccountEvent[] = [];
  let webhookCount = 0;
  let currentStatusCount = 0;
  let liveBisonCount = 0;

  for (const d of disconnectByKey.values()) {
    const key = `${d.instance}:${d.sender_id}`;
    const r = reconnectByKey.get(key);
    const reconnectAfterDisconnect = r && r.occurred_at >= d.detected_at;
    const cachedStatus = inboxStatusByKey.get(key);
    const inferredReconnected =
      cachedStatus !== undefined && !looksDisconnected(cachedStatus);
    const liveOk = liveChecked.has(key) && !liveStillDisconnected.has(key);

    const base: AccountEvent = {
      instance: d.instance,
      sender_id: d.sender_id,
      sender_email: d.sender_email,
      sender_name: d.sender_name,
      detected_at: d.detected_at,
    };
    disconnectedAccounts.push(base);

    if (reconnectAfterDisconnect) {
      reconnectedAccounts.push({ ...base, reconnected_at: r.occurred_at, reconnect_source: "webhook" });
      webhookCount++;
    } else if (inferredReconnected) {
      reconnectedAccounts.push({ ...base, reconnect_source: "current_status" });
      currentStatusCount++;
    } else if (liveOk) {
      reconnectedAccounts.push({ ...base, reconnect_source: "live_bison" });
      liveBisonCount++;
    } else {
      failedAccounts.push(base);
    }
  }

  // Per-instance breakdown — initialise all 4 so the report shows zeros, not gaps.
  const perInstanceMap = new Map<BisonInstanceSlug, { disconnected: number; reconnected: number; failed: number }>();
  for (const slug of ALL_INSTANCE_SLUGS) {
    perInstanceMap.set(slug, { disconnected: 0, reconnected: 0, failed: 0 });
  }
  for (const a of disconnectedAccounts) perInstanceMap.get(a.instance)!.disconnected++;
  for (const a of reconnectedAccounts) perInstanceMap.get(a.instance)!.reconnected++;
  for (const a of failedAccounts) perInstanceMap.get(a.instance)!.failed++;

  return {
    date: pstDate,
    totals: {
      disconnected: disconnectedAccounts.length,
      reconnected: reconnectedAccounts.length,
      failed: failedAccounts.length,
    },
    perInstance: ALL_INSTANCE_SLUGS.map((slug) => ({
      instance: slug,
      ...perInstanceMap.get(slug)!,
    })),
    disconnectedAccounts,
    reconnectedAccounts,
    failedAccounts,
    reconnectSources: { webhook: webhookCount, current_status: currentStatusCount, live_bison: liveBisonCount },
    liveVerified: options.verify === true,
  };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const date = searchParams.get("date") || todayPstDateString();
    const verify = searchParams.get("verify") === "1";

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "Invalid date — expected YYYY-MM-DD" }, { status: 400 });
    }

    const report = await buildAccountStatusReport(date, { verify });
    return NextResponse.json(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
