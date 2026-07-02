import { NextResponse } from "next/server";
import { isInstanceSlug } from "@/lib/bison-instances";
import { handleSenderReconnect } from "@/lib/handle-sender-reconnect";

export const maxDuration = 30;

/**
 * Bison webhook receiver: re-applies tags to a sender account after it
 * reconnects. See src/lib/handle-sender-reconnect.ts for the actual logic —
 * this route is a thin adapter that parses the Bison payload shape.
 *
 * Bison fires `EMAIL_ACCOUNT_RECONNECTED` with:
 *   { "event": { "type": "EMAIL_ACCOUNT_RECONNECTED", ... },
 *     "data": { "sender_email": { "id": 2, "email": "...", ... } } }
 *
 * One URL per instance (slug in the path tells us which Bison to call back):
 *   /api/webhooks/bison-reconnect/outboundhero  (etc.)
 *
 * No signature verification — Bison doesn't sign webhooks; the URL is the secret.
 * Note: Bison rarely actually fires this event — for transient disconnects that
 * self-heal, the disconnect webhook payload arrives with status="connected"
 * and we route THAT through the same helper. See bison-disconnect route.
 */

interface BisonReconnectPayload {
  event?: { type?: string };
  data?: { sender_email?: { id?: number; email?: string } };
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

  const senderId = typeof payload?.data?.sender_email?.id === "number" ? payload.data.sender_email.id : null;
  const senderEmail = payload?.data?.sender_email?.email ?? null;
  if (senderId === null) {
    console.error(
      `[webhook/reconnect:${instance}] missing data.sender_email.id`,
      JSON.stringify(payload).slice(0, 400),
    );
    return NextResponse.json({ error: "Missing data.sender_email.id" }, { status: 400 });
  }

  const result = await handleSenderReconnect({
    instance, senderId, senderEmail, source: "webhook_reconnect",
  });

  if (!result.ok) {
    // 500 so Bison retries — a transient failure shouldn't lose the reconnect.
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }

  console.log(
    `[webhook/reconnect:${instance}] restored ${result.restored} tag(s) to sender ${senderId} (${senderEmail})`,
  );
  return NextResponse.json({
    ok: true,
    instance,
    senderId,
    senderEmail,
    restored: result.restored,
    total: result.total,
    note: result.note,
    queued_for_conform_and_attach: true,
  });
}
