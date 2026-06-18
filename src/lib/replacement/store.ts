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

export async function getEvents(limit = 200): Promise<ReplacementEvent[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("replacement_events")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(Math.min(limit, 1000));
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
