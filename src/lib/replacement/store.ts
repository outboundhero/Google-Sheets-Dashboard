// Data access for the replacement system. Isolated — server-only (uses the
// service-role admin client). Reads/writes only the new replacement_* tables.
import { getSupabaseAdmin } from "@/lib/supabase";
import type { BisonInstanceSlug } from "@/lib/bison-instances";
import {
  DEFAULT_SETTINGS,
  type ReplacementSettings,
  type ReplacementMode,
  type LookbackWindow,
  type ReplacementEvent,
  type ReplacementEventType,
} from "./types";

// --- Settings (single row, id = 1) -----------------------------------------
export async function getSettings(): Promise<ReplacementSettings> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("replacement_settings")
    .select("*")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return { ...DEFAULT_SETTINGS };
  return {
    mode: data.mode as ReplacementMode,
    minReplyRate: data.min_reply_rate,
    maxBounceRate: data.max_bounce_rate,
    flagOnSurbl: data.flag_on_surbl,
    flagOnSpamhaus: data.flag_on_spamhaus,
    // ?? true: column may not exist yet — decision default is "allow".
    allowSurblReserves: data.allow_surbl_reserves ?? true,
    minSignals: data.min_signals,
    lookbackWindow: data.lookback_window as LookbackWindow,
    minSent: data.min_sent,
  };
}

export async function updateSettings(patch: Partial<ReplacementSettings>): Promise<ReplacementSettings> {
  const supabase = getSupabaseAdmin();
  const row: Record<string, unknown> = { id: 1, updated_at: new Date().toISOString() };
  if (patch.mode !== undefined) row.mode = patch.mode;
  if (patch.minReplyRate !== undefined) row.min_reply_rate = patch.minReplyRate;
  if (patch.maxBounceRate !== undefined) row.max_bounce_rate = patch.maxBounceRate;
  if (patch.flagOnSurbl !== undefined) row.flag_on_surbl = patch.flagOnSurbl;
  if (patch.flagOnSpamhaus !== undefined) row.flag_on_spamhaus = patch.flagOnSpamhaus;
  if (patch.allowSurblReserves !== undefined) row.allow_surbl_reserves = patch.allowSurblReserves;
  if (patch.minSignals !== undefined) row.min_signals = patch.minSignals;
  if (patch.lookbackWindow !== undefined) row.lookback_window = patch.lookbackWindow;
  if (patch.minSent !== undefined) row.min_sent = patch.minSent;
  const { error } = await supabase.from("replacement_settings").upsert(row, { onConflict: "id" });
  if (error) throw new Error(error.message);
  return getSettings();
}

// --- Events (audit log) -----------------------------------------------------
export interface NewEvent {
  instance?: BisonInstanceSlug | null;
  domain?: string | null;
  clientTag?: string | null;
  eventType: ReplacementEventType;
  detail?: string | null;
  signals?: Record<string, unknown> | null;
}

export async function logEvents(events: NewEvent[]): Promise<void> {
  if (events.length === 0) return;
  const supabase = getSupabaseAdmin();
  const rows = events.map((e) => ({
    instance: e.instance ?? null,
    domain: e.domain ?? null,
    client_tag: e.clientTag ?? null,
    event_type: e.eventType,
    detail: e.detail ?? null,
    signals: e.signals ?? null,
  }));
  const { error } = await supabase.from("replacement_events").insert(rows);
  if (error) throw new Error(error.message);
}

// --- Domain lifecycle state -------------------------------------------------
export interface LifecycleUpdate {
  instance: BisonInstanceSlug;
  domain: string;
  state: "reserve" | "assigned" | "flagged" | "replacing" | "removed" | "retired";
  clientTag?: string | null;
  reason?: string | null;
}

export async function setLifecycle(updates: LifecycleUpdate[]): Promise<void> {
  if (updates.length === 0) return;
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const rows = updates.map((u) => ({
    instance: u.instance,
    domain: u.domain,
    state: u.state,
    assigned_client_tag: u.clientTag ?? null,
    flagged_reason: u.reason ?? null,
    updated_at: now,
  }));
  const { error } = await supabase
    .from("domain_replacement_state")
    .upsert(rows, { onConflict: "instance,domain" });
  if (error) throw new Error(error.message);
}

// --- Cancellation scheduling (5-day vendor-delete grace) ---------------------
export const CANCEL_GRACE_DAYS = 5;

export interface CancellationEntry {
  instance: BisonInstanceSlug;
  domain: string;
  clientTag?: string | null;
  provider?: string | null;
  reason?: string | null;
}

/** Schedule burnt domains for vendor cancellation `graceDays` from now. Does
 *  NOT delete anything — just records intent; a later cron actions it. */
export async function scheduleCancellations(
  entries: CancellationEntry[],
  graceDays = CANCEL_GRACE_DAYS,
): Promise<void> {
  if (entries.length === 0) return;
  const supabase = getSupabaseAdmin();
  const scheduledAt = new Date(Date.now() + graceDays * 86_400_000).toISOString();
  const rows = entries.map((e) => ({
    instance: e.instance,
    domain: e.domain,
    client_tag: e.clientTag ?? null,
    provider: e.provider ?? null,
    reason: e.reason ?? null,
    scheduled_at: scheduledAt,
    status: "pending",
  }));
  const { error } = await supabase
    .from("replacement_cancellations")
    .upsert(rows, { onConflict: "instance,domain", ignoreDuplicates: true });
  if (error) throw new Error(error.message);
}

/** Domains already acted on (removed/in-flight) — so detection & the plan stop
 *  showing them the moment execution finishes. Keyed `${instance}:${domain}`. */
export async function getHandledDomains(): Promise<Set<string>> {
  const supabase = getSupabaseAdmin();
  const set = new Set<string>();
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("domain_replacement_state")
      .select("instance,domain")
      .in("state", ["removed", "replacing", "retired"])
      .range(offset, offset + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const r of data) set.add(`${r.instance}:${r.domain}`);
    if (data.length < 1000) break;
    offset += 1000;
  }
  return set;
}

export interface PendingCancellation {
  instance: string;
  domain: string;
  clientTag: string | null;
  provider: string | null;
  reason: string | null;
  scheduledAt: string;
  status: string;
  createdAt: string;
}

/** Detect the inbox VENDOR (who hosts/bills the mailboxes) from a domain's tags
 *  — same convention the change-redirect route uses. */
function detectVendor(tags: string[] | null): string {
  const lower = (tags || []).map((t) => String(t).toLowerCase());
  if (lower.some((t) => t.includes("milkbox"))) return "milkbox";
  if (lower.some((t) => t.includes("inboxing"))) return "inboxing";
  if (lower.some((t) => t.includes("scaledmail") || t.includes("scaled mail"))) return "scaledmail";
  if (lower.some((t) => t.includes("cheap"))) return "cheap";
  return "unknown";
}

/** The cancellation queue — burnt domains awaiting the 5-day vendor-delete.
 *  Enriches each row with the inbox vendor (from the domain's current tags). */
export async function getCancellations(statuses: string[] = ["pending"], limit = 1000): Promise<PendingCancellation[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("replacement_cancellations")
    .select("*")
    .in("status", statuses)
    .order("scheduled_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  const rows = data || [];

  // look up tags → vendor for these domains (so we show who hosts each)
  const vendorByKey = new Map<string, string>();
  const domains = [...new Set(rows.map((r) => r.domain))];
  for (let i = 0; i < domains.length; i += 200) {
    const batch = domains.slice(i, i + 200);
    const { data: tagRows } = await supabase
      .from("deliverability_domains")
      .select("instance,domain,tags")
      .in("domain", batch);
    for (const t of tagRows || []) vendorByKey.set(`${t.instance}:${t.domain}`, detectVendor(t.tags));
  }

  return rows.map((r) => ({
    instance: r.instance, domain: r.domain, clientTag: r.client_tag,
    provider: r.provider || vendorByKey.get(`${r.instance}:${r.domain}`) || "unknown",
    reason: r.reason, scheduledAt: r.scheduled_at, status: r.status, createdAt: r.created_at,
  }));
}

export async function getEvents(
  limit = 200,
  opts: { withinDays?: number; olderThanDays?: number } = {},
): Promise<ReplacementEvent[]> {
  const supabase = getSupabaseAdmin();
  let q = supabase
    .from("replacement_events")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(Math.min(limit, 1000));
  // trailing-window vs archive views (Spencer: show 7 days, archive older) —
  // rows are never deleted; "archive" is just the >N-days slice of the table
  if (opts.withinDays && opts.withinDays > 0) {
    q = q.gte("created_at", new Date(Date.now() - opts.withinDays * 86_400_000).toISOString());
  }
  if (opts.olderThanDays && opts.olderThanDays > 0) {
    q = q.lt("created_at", new Date(Date.now() - opts.olderThanDays * 86_400_000).toISOString());
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []).map((r) => ({
    id: r.id,
    instance: r.instance,
    domain: r.domain,
    clientTag: r.client_tag,
    eventType: r.event_type as ReplacementEventType,
    detail: r.detail,
    signals: r.signals,
    createdAt: r.created_at,
  }));
}
