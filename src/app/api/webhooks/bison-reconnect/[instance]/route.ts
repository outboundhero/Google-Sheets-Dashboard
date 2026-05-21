import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import { isInstanceSlug } from "@/lib/bison-instances";

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
 *   /api/webhooks/bison-reconnect/outboundhero
 *   /api/webhooks/bison-reconnect/cleaningoutbound
 *   /api/webhooks/bison-reconnect/facilityreach
 *   /api/webhooks/bison-reconnect/outboundclean
 *
 * No signature verification — Bison doesn't sign webhooks; the URL is the secret.
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

export async function POST(
  request: Request,
  context: { params: Promise<{ instance: string }> },
) {
  const { instance: instanceParam } = await context.params;

  if (!isInstanceSlug(instanceParam)) {
    return NextResponse.json({ error: `Unknown instance: ${instanceParam}` }, { status: 400 });
  }
  const instance = instanceParam;

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

    const senderId = payload?.data?.sender_email?.id;
    const senderEmail = payload?.data?.sender_email?.email ?? null;
    if (typeof senderId !== "number") {
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
      return NextResponse.json({ ok: true, restored: 0, note: "Sender not yet synced" });
    }

    const rawTags = (inbox as { tags?: unknown }).tags;
    const storedTags: StoredTag[] = Array.isArray(rawTags) ? rawTags.filter(isStoredTag) : [];
    if (storedTags.length === 0) {
      console.log(
        `[webhook/reconnect:${instance}] sender ${senderId} (${senderEmail}) had no stored tags`,
      );
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
    return NextResponse.json({
      ok: true,
      instance,
      senderId,
      senderEmail,
      restored: resolvedIds.length,
      total: storedTags.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Webhook failed";
    console.error(`[webhook/reconnect:${instance}]`, message);
    // 500 so Bison retries — a transient Bison/Supabase failure shouldn't lose the restore.
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
