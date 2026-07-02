import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import { isInstanceSlug } from "@/lib/bison-instances";
import { enqueueReconnect } from "@/lib/reconnect-worker";

export const maxDuration = 30;

/**
 * Bison webhook receiver: re-applies tags to a sender account after it
 * reconnects. Bison wipes a sender's tags on reconnect; LeadSync is the source
 * of truth (tags are stored on `deliverability_inboxes.tags` at each sync), so
 * we look the sender up and re-apply its last-known tags to that Bison instance.
 *
 * Bison fires `EMAIL_ACCOUNT_RECONNECTED` with:
 *   { "event": { "type": "EMAIL_ACCOUNT_RECONNECTED", ... },
 *     "data": { "sender_email": { "id": 2, "email": "...", ... } } }
 *
 * One URL per instance (slug in the path tells us which Bison to call back):
 *   /api/webhooks/bison-reconnect/outboundhero  (etc.)
 *
 * No signature verification — Bison doesn't sign webhooks; the URL is the secret.
 * Every meaningful outcome is recorded in the `reconnect_tag_log` table so it
 * can be reviewed in the dashboard.
 */

interface BisonReconnectPayload {
  event?: { type?: string };
  data?: { sender_email?: { id?: number; email?: string } };
}

interface StoredTag {
  id: number;
  name: string;
}

interface BisonTag {
  id: number;
  name: string;
}

function isStoredTag(v: unknown): v is StoredTag {
  if (!v || typeof v !== "object") return false;
  const o = v as { id?: unknown; name?: unknown };
  return typeof o.id === "number" && typeof o.name === "string";
}

/** Records one reconnect outcome. Never throws — logging must not break the webhook. */
async function logReconnect(entry: {
  instance: string;
  senderId: number | null;
  senderEmail: string | null;
  tagsRestored: number;
  tagsTotal: number;
  status: "ok" | "skipped" | "failed";
  error?: string | null;
}): Promise<void> {
  try {
    await getSupabaseAdmin().from("reconnect_tag_log").insert({
      instance: entry.instance,
      sender_id: entry.senderId,
      sender_email: entry.senderEmail,
      tags_restored: entry.tagsRestored,
      tags_total: entry.tagsTotal,
      status: entry.status,
      error: entry.error ?? null,
    });
  } catch (e) {
    console.error("[webhook/reconnect] log write failed:", e);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ instance: string }> },
) {
  const { instance: instanceParam } = await context.params;

  if (!isInstanceSlug(instanceParam)) {
    return NextResponse.json({ error: `Unknown instance: ${instanceParam}` }, { status: 400 });
  }
  const instance = instanceParam;

  let senderId: number | null = null;
  let senderEmail: string | null = null;

  try {
    let payload: BisonReconnectPayload;
    try {
      payload = (await request.json()) as BisonReconnectPayload;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // Only act on reconnects. Ack other/empty events with 200 (Bison test fires, etc.).
    const eventType = payload?.event?.type;
    if (eventType && eventType !== "EMAIL_ACCOUNT_RECONNECTED") {
      console.log(`[webhook/reconnect:${instance}] skipped event=${eventType}`);
      return NextResponse.json({ ok: true, skipped: `event=${eventType}` });
    }

    senderId = typeof payload?.data?.sender_email?.id === "number" ? payload.data.sender_email.id : null;
    senderEmail = payload?.data?.sender_email?.email ?? null;
    if (senderId === null) {
      console.error(
        `[webhook/reconnect:${instance}] missing data.sender_email.id`,
        JSON.stringify(payload).slice(0, 400),
      );
      return NextResponse.json({ error: "Missing data.sender_email.id" }, { status: 400 });
    }

    // 1. Last-known tags for this sender, from our store.
    const supabase = getSupabaseAdmin();
    const { data: inbox, error: inboxErr } = await supabase
      .from("deliverability_inboxes")
      .select("tags")
      .eq("instance", instance)
      .eq("id", senderId)
      .maybeSingle();
    if (inboxErr) throw new Error(`Supabase lookup failed: ${inboxErr.message}`);

    if (!inbox) {
      console.log(
        `[webhook/reconnect:${instance}] sender ${senderId} (${senderEmail}) not synced yet — nothing to restore`,
      );
      await logReconnect({
        instance, senderId, senderEmail, tagsRestored: 0, tagsTotal: 0,
        status: "skipped", error: "Sender not yet synced to LeadSync",
      });
      return NextResponse.json({ ok: true, restored: 0, note: "Sender not yet synced" });
    }

    const rawTags = (inbox as { tags?: unknown }).tags;
    const storedTags: StoredTag[] = Array.isArray(rawTags) ? rawTags.filter(isStoredTag) : [];
    if (storedTags.length === 0) {
      console.log(
        `[webhook/reconnect:${instance}] sender ${senderId} (${senderEmail}) had no stored tags`,
      );
      await logReconnect({
        instance, senderId, senderEmail, tagsRestored: 0, tagsTotal: 0,
        status: "skipped", error: "No stored tags to restore",
      });
      return NextResponse.json({ ok: true, restored: 0 });
    }

    // 2. Resolve tag names -> current Bison tag IDs. Match by NAME (IDs can drift);
    //    recreate any tag that no longer exists in Bison.
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
        console.warn(`[webhook/reconnect:${instance}] could not recreate tag "${name}": ${createRes.status}`);
      }
    }

    if (resolvedIds.length === 0) {
      await logReconnect({
        instance, senderId, senderEmail, tagsRestored: 0, tagsTotal: storedTags.length,
        status: "skipped", error: "No tags could be resolved",
      });
      return NextResponse.json({ ok: true, restored: 0, note: "no tags resolved" });
    }

    // 3. Re-attach the resolved tags to the reconnected sender (proven Bison endpoint).
    const attachRes = await bisonFetch(instance, `/tags/attach-to-sender-emails`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag_ids: resolvedIds, sender_email_ids: [senderId] }),
    });
    if (!attachRes.ok) {
      const txt = await attachRes.text().catch(() => "");
      throw new Error(`Failed to attach tags: ${attachRes.status} ${txt.slice(0, 200)}`);
    }

    console.log(
      `[webhook/reconnect:${instance}] restored ${resolvedIds.length} tag(s) to sender ${senderId} (${senderEmail})`,
    );
    await logReconnect({
      instance, senderId, senderEmail,
      tagsRestored: resolvedIds.length, tagsTotal: storedTags.length, status: "ok",
    });

    // Enqueue the post-reconnect work (conform tags against the domain's
    // wanted set + attach the sender to matching campaigns). We do this
    // AFTER the tag restore has succeeded — no point queuing work if the
    // primary restore failed. The worker drains this queue every 5 min
    // (see /api/cron/reconnect-worker).
    await enqueueReconnect({ instance, senderId, senderEmail });

    return NextResponse.json({
      ok: true,
      instance,
      senderId,
      senderEmail,
      restored: resolvedIds.length,
      total: storedTags.length,
      queued_for_conform_and_attach: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Webhook failed";
    console.error(`[webhook/reconnect:${instance}]`, message);
    await logReconnect({
      instance, senderId, senderEmail, tagsRestored: 0, tagsTotal: 0,
      status: "failed", error: message,
    });
    // 500 so Bison retries — a transient Bison/Supabase failure shouldn't lose the restore.
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
