import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { ALL_INSTANCE_SLUGS, type BisonInstanceSlug } from "@/lib/bison-instances";

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
}

export interface AccountStatusReport {
  date: string;
  totals: { disconnected: number; reconnected: number; failed: number };
  perInstance: { instance: BisonInstanceSlug; disconnected: number; reconnected: number; failed: number }[];
  disconnectedAccounts: AccountEvent[];
  reconnectedAccounts: AccountEvent[];
  failedAccounts: AccountEvent[];
}

export async function buildAccountStatusReport(pstDate: string): Promise<AccountStatusReport> {
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

  const disconnectedAccounts: AccountEvent[] = [];
  const reconnectedAccounts: AccountEvent[] = [];
  const failedAccounts: AccountEvent[] = [];

  for (const d of disconnectByKey.values()) {
    const key = `${d.instance}:${d.sender_id}`;
    const r = reconnectByKey.get(key);
    const reconnectAfterDisconnect = r && r.occurred_at >= d.detected_at;
    const base: AccountEvent = {
      instance: d.instance,
      sender_id: d.sender_id,
      sender_email: d.sender_email,
      sender_name: d.sender_name,
      detected_at: d.detected_at,
    };
    disconnectedAccounts.push(base);
    if (reconnectAfterDisconnect) {
      reconnectedAccounts.push({ ...base, reconnected_at: r.occurred_at });
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
  };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const date = searchParams.get("date") || todayPstDateString();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "Invalid date — expected YYYY-MM-DD" }, { status: 400 });
    }

    const report = await buildAccountStatusReport(date);
    return NextResponse.json(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
