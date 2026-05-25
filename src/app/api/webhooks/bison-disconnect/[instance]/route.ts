import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { isInstanceSlug } from "@/lib/bison-instances";

export const maxDuration = 30;

/**
 * Bison webhook receiver: logs sender disconnections to `disconnect_events`.
 * Counterpart to /api/webhooks/bison-reconnect (which restores tags on reconnect
 * and logs to `reconnect_tag_log`).
 *
 * Bison fires `EMAIL_ACCOUNT_DISCONNECTED` with the same shape as the reconnect
 * event:
 *   { "event": { "type": "EMAIL_ACCOUNT_DISCONNECTED", ... },
 *     "data": { "sender_email": { "id": 2, "email": "...", "name": "..." } } }
 *
 * One URL per instance (slug in the path):
 *   /api/webhooks/bison-disconnect/outboundhero  (etc.)
 *
 * No signature verification — the URL itself is the secret (per the existing
 * reconnect webhook convention).
 */

interface BisonDisconnectPayload {
  event?: { type?: string };
  data?: { sender_email?: { id?: number; email?: string; name?: string } };
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

  let payload: BisonDisconnectPayload;
  try {
    payload = (await request.json()) as BisonDisconnectPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Only act on disconnects. Any other event (Bison test fires, reconnects sent here by mistake, etc.) → 200 OK.
  const eventType = payload?.event?.type;
  if (eventType && eventType !== "EMAIL_ACCOUNT_DISCONNECTED") {
    console.log(`[webhook/disconnect:${instance}] skipped event=${eventType}`);
    return NextResponse.json({ ok: true, skipped: `event=${eventType}` });
  }

  const senderId = typeof payload?.data?.sender_email?.id === "number" ? payload.data.sender_email.id : null;
  const senderEmail = payload?.data?.sender_email?.email ?? null;
  const senderName = payload?.data?.sender_email?.name ?? null;

  if (senderId === null) {
    console.error(
      `[webhook/disconnect:${instance}] missing data.sender_email.id`,
      JSON.stringify(payload).slice(0, 400),
    );
    return NextResponse.json({ error: "Missing data.sender_email.id" }, { status: 400 });
  }

  try {
    const { error } = await getSupabaseAdmin().from("disconnect_events").insert({
      instance,
      sender_id: senderId,
      sender_email: senderEmail,
      sender_name: senderName,
      raw_payload: payload as unknown as Record<string, unknown>,
    });
    if (error) throw new Error(`Supabase insert failed: ${error.message}`);

    console.log(
      `[webhook/disconnect:${instance}] logged sender ${senderId} (${senderEmail ?? "?"})`,
    );
    return NextResponse.json({ ok: true, instance, senderId, senderEmail });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Webhook failed";
    console.error(`[webhook/disconnect:${instance}]`, message);
    // 500 so Bison retries — a transient DB failure shouldn't lose the event.
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
