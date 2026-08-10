import { bisonFetch } from "@/lib/bison";
import type { BisonInstanceSlug } from "@/lib/bison-instances";
import type { SupabaseClient } from "@supabase/supabase-js";

// Campaign duplication helpers. Bison: POST /campaigns/{id}/duplicate → 201,
// creates a DRAFT copy (sequence preserved, 0 leads). Confirmed in the Phase-0
// spike. The set-role order (Google + Custom → Outlook → SEGs) drives queue
// ordering within a client tag.

export const SET_ROLE_ORDER: Record<string, number> = { google_custom: 0, outlook: 1, segs: 2 };
export function setRoleIndex(role: string | null | undefined): number {
  return role && role in SET_ROLE_ORDER ? SET_ROLE_ORDER[role] : 9;
}
export function setRoleLabel(role: string | null | undefined): string {
  return role === "google_custom" ? "Google + Custom" : role === "outlook" ? "Outlook" : role === "segs" ? "SEGs" : "—";
}

export interface DuplicateResult { ok: boolean; newId?: number; newName?: string; error?: string }

export async function duplicateOne(instance: BisonInstanceSlug, sourceId: number): Promise<DuplicateResult> {
  try {
    const res = await bisonFetch(instance, `/campaigns/${sourceId}/duplicate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const text = await res.text();
    let j: { data?: { id?: number; name?: string; message?: string }; message?: string } | null = null;
    try { j = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok) {
      return { ok: false, error: j?.data?.message || j?.message || `Bison ${res.status}: ${text.slice(0, 140)}` };
    }
    const data = j?.data;
    if (!data?.id) return { ok: false, error: "duplicate returned no campaign id" };
    return { ok: true, newId: data.id, newName: data.name };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "duplicate failed" };
  }
}

export async function logCampaignEvent(
  sb: SupabaseClient,
  ev: { instance?: string | null; campaignId?: number | null; clientTag?: string | null; eventType: string; detail?: string | null; actor?: string | null; meta?: Record<string, unknown> | null },
): Promise<void> {
  try {
    await sb.from("campaign_events").insert({
      instance: ev.instance ?? null,
      campaign_id: ev.campaignId ?? null,
      client_tag: ev.clientTag ?? null,
      event_type: ev.eventType,
      detail: ev.detail ?? null,
      actor: ev.actor ?? "automation",
      meta: ev.meta ?? null,
    });
  } catch { /* history is best-effort */ }
}
