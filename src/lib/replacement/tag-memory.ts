// The MEMORY BANK's read side (Spencer's Loom, 2026-09-03): which client tag
// did a domain last carry, per the recorded workflow history. Inboxing keeps
// no client tags, so a domain that's disconnected and re-added comes back
// nameless — the events log is the only place its ownership survives. This is
// deliberately history-first: Spencer was explicit that restores should come
// "not because of the redirect URL, but because we knew there was JPLV on
// here before".
import { getSupabaseAdmin } from "@/lib/supabase";

export interface LastTag {
  tag: string;         // UPPERCASE client tag
  at: string;          // when the event happened
  eventType: string;   // which event carried it (tagged / removed / attached…)
}

/** `${instance}:${domain}` → most recent client tag seen in the events log.
 *  A 'removed' event still names the last owner (removed FROM that client),
 *  so any event with a client_tag counts — recency wins. */
export async function getLastClientTags(): Promise<Map<string, LastTag>> {
  const supabase = getSupabaseAdmin();
  const out = new Map<string, LastTag>();
  // Ascending scan: later rows overwrite earlier ones → map ends at latest.
  for (let off = 0; ; off += 1000) {
    const { data, error } = await supabase
      .from("replacement_events")
      .select("instance, domain, client_tag, event_type, created_at")
      .not("client_tag", "is", null)
      .not("domain", "is", null)
      .order("created_at", { ascending: true })
      .range(off, off + 999);
    if (error) throw new Error(`replacement_events: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const e of data as { instance: string | null; domain: string; client_tag: string; event_type: string; created_at: string }[]) {
      if (!e.instance) continue;
      out.set(`${e.instance}:${e.domain.toLowerCase()}`, {
        tag: e.client_tag.trim().toUpperCase(),
        at: e.created_at,
        eventType: e.event_type,
      });
    }
    if (data.length < 1000) break;
  }
  return out;
}
