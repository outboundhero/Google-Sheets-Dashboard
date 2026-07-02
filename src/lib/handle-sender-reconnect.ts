// Shared "sender got reconnected" handler.
//
// Bison fires EMAIL_ACCOUNT_RECONNECTED only for a subset of reconnects
// (manual UI re-auth). For transient auth blips that self-heal via
// silent OAuth token refresh, Bison fires EMAIL_ACCOUNT_DISCONNECTED but
// by the time the webhook arrives sender_email.status is already
// "connected" — no separate reconnect event ever fires.
//
// So both webhooks funnel through this helper:
//   - bison-reconnect always calls it (the explicit path)
//   - bison-disconnect calls it when the payload's sender_email.status
//     comes in already showing "connected" (the transient-recovered path)
//
// What it does per sender:
//   1. Reads deliverability_inboxes.tags (last-known tags at the previous
//      sync). Bison sometimes drops tags on reconnect; this restores them.
//   2. Attaches those tags to the sender via /tags/attach-to-sender-emails.
//      Idempotent — if Bison still has them, it's a no-op.
//   3. Writes a reconnect_tag_log row with the outcome.
//   4. Enqueues pending_reconnect_work so /api/cron/reconnect-worker will
//      conform the sender's tags against its domain and attach to
//      matching campaigns.

import { bisonFetch } from "@/lib/bison";
import { getSupabaseAdmin } from "@/lib/supabase";
import type { BisonInstanceSlug } from "@/lib/bison-instances";
import { enqueueReconnect } from "@/lib/reconnect-worker";

interface StoredTag { id: number; name: string }
interface BisonTag { id: number; name: string }

function isStoredTag(v: unknown): v is StoredTag {
  if (!v || typeof v !== "object") return false;
  const o = v as { id?: unknown; name?: unknown };
  return typeof o.id === "number" && typeof o.name === "string";
}

async function logReconnect(entry: {
  instance: string;
  senderId: number | null;
  senderEmail: string | null;
  tagsRestored: number;
  tagsTotal: number;
  status: "ok" | "skipped" | "failed";
  error?: string | null;
  source: "webhook_reconnect" | "webhook_disconnect_auto_recovered";
}): Promise<void> {
  try {
    await getSupabaseAdmin().from("reconnect_tag_log").insert({
      instance: entry.instance,
      sender_id: entry.senderId,
      sender_email: entry.senderEmail,
      tags_restored: entry.tagsRestored,
      tags_total: entry.tagsTotal,
      status: entry.status,
      error: entry.error ?? (entry.source === "webhook_disconnect_auto_recovered"
        ? "auto-recovered from disconnect webhook (status was already connected)"
        : null),
    });
  } catch (e) {
    // Log-only — a logging miss must not break the caller's response.
    console.error("[handleSenderReconnect] log write failed:", e);
  }
}

export interface HandleSenderReconnectResult {
  ok: boolean;
  restored: number;
  total: number;
  note?: string;
  error?: string;
}

export async function handleSenderReconnect(entry: {
  instance: BisonInstanceSlug;
  senderId: number;
  senderEmail: string | null;
  /** Which webhook triggered this — recorded in the log entry for auditing. */
  source: "webhook_reconnect" | "webhook_disconnect_auto_recovered";
}): Promise<HandleSenderReconnectResult> {
  const { instance, senderId, senderEmail, source } = entry;

  try {
    const supabase = getSupabaseAdmin();

    // 1. Last-known tags for this sender, from our store.
    const { data: inbox, error: inboxErr } = await supabase
      .from("deliverability_inboxes")
      .select("tags")
      .eq("instance", instance)
      .eq("id", senderId)
      .maybeSingle();
    if (inboxErr) throw new Error(`Supabase lookup failed: ${inboxErr.message}`);

    if (!inbox) {
      await logReconnect({
        instance, senderId, senderEmail, tagsRestored: 0, tagsTotal: 0,
        status: "skipped", error: "Sender not yet synced to LeadSync", source,
      });
      // Still enqueue: the queue worker will re-check the cache when it runs
      // (attempts * 5 min later), and by then the sync-deliverability cron
      // may have brought the sender in. Idempotent upsert on (instance, sender_id).
      await enqueueReconnect({ instance, senderId, senderEmail });
      return { ok: true, restored: 0, total: 0, note: "Sender not yet synced" };
    }

    const rawTags = (inbox as { tags?: unknown }).tags;
    const storedTags: StoredTag[] = Array.isArray(rawTags) ? rawTags.filter(isStoredTag) : [];
    if (storedTags.length === 0) {
      await logReconnect({
        instance, senderId, senderEmail, tagsRestored: 0, tagsTotal: 0,
        status: "skipped", error: "No stored tags to restore", source,
      });
      // Still enqueue so conform-tags can add the tags the domain wants
      // (they may not be in the sender's stored tags yet — new deployment).
      await enqueueReconnect({ instance, senderId, senderEmail });
      return { ok: true, restored: 0, total: 0 };
    }

    // 2. Resolve tag names → current Bison tag IDs. Match by NAME (Bison
    //    IDs can drift on rebuild); recreate any that no longer exist.
    const tagsRes = await bisonFetch(instance, `/tags`);
    if (!tagsRes.ok) throw new Error(`Failed to list Bison tags: ${tagsRes.status}`);
    const tagsJson = await tagsRes.json();
    const currentTags: BisonTag[] = tagsJson.data || [];
    const byName = new Map(currentTags.map((t) => [t.name.toLowerCase(), t]));

    const resolvedIds: number[] = [];
    for (const stored of storedTags) {
      const name = stored.name.trim();
      if (!name) continue;
      const existing = byName.get(name.toLowerCase());
      if (existing) {
        resolvedIds.push(existing.id);
        continue;
      }
      // Tag no longer exists in Bison — recreate it.
      const createRes = await bisonFetch(instance, `/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (createRes.ok) {
        const created = await createRes.json();
        const newTag: BisonTag = created.data || created;
        if (newTag?.id) {
          resolvedIds.push(newTag.id);
          byName.set(name.toLowerCase(), newTag);
        }
      } else {
        console.warn(`[handleSenderReconnect:${instance}] could not recreate tag "${name}": ${createRes.status}`);
      }
    }

    if (resolvedIds.length === 0) {
      await logReconnect({
        instance, senderId, senderEmail, tagsRestored: 0, tagsTotal: storedTags.length,
        status: "skipped", error: "No tags could be resolved", source,
      });
      await enqueueReconnect({ instance, senderId, senderEmail });
      return { ok: true, restored: 0, total: storedTags.length, note: "no tags resolved" };
    }

    // 3. Re-attach the resolved tags. Idempotent on Bison's side — duplicates
    //    silently no-op.
    const attachRes = await bisonFetch(instance, `/tags/attach-to-sender-emails`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag_ids: resolvedIds, sender_email_ids: [senderId] }),
    });
    if (!attachRes.ok) {
      const txt = await attachRes.text().catch(() => "");
      throw new Error(`Failed to attach tags: ${attachRes.status} ${txt.slice(0, 200)}`);
    }

    await logReconnect({
      instance, senderId, senderEmail,
      tagsRestored: resolvedIds.length, tagsTotal: storedTags.length, status: "ok",
      source,
    });

    // 4. Queue post-reconnect work (conform tags against domain wanted set +
    //    attach sender to matching campaigns).
    await enqueueReconnect({ instance, senderId, senderEmail });

    return { ok: true, restored: resolvedIds.length, total: storedTags.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : "handleSenderReconnect failed";
    console.error(`[handleSenderReconnect:${instance}] sender ${senderId}:`, message);
    await logReconnect({
      instance, senderId, senderEmail, tagsRestored: 0, tagsTotal: 0,
      status: "failed", error: message, source,
    });
    return { ok: false, restored: 0, total: 0, error: message };
  }
}
