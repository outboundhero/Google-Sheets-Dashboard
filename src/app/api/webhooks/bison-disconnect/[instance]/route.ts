import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { isInstanceSlug } from "@/lib/bison-instances";
import { handleSenderReconnect } from "@/lib/handle-sender-reconnect";

export const maxDuration = 30;

/**
 * Bison webhook receiver for EMAIL_ACCOUNT_DISCONNECTED.
 *
 * Behavior:
 *   1. Always log the raw event to `disconnect_events`.
 *   2. Look at the sender_email.status embedded in the payload:
 *        - "connected"  → Bison already auto-recovered the account (silent
 *          OAuth refresh, transient auth blip). Treat this as a reconnect
 *          event and route through handleSenderReconnect so we restore tags
 *          + enqueue conform-tags + attach-to-campaigns work. This is the
 *          common case — Bison rarely fires an actual EMAIL_ACCOUNT_RECONNECTED
 *          event; the sender status field on the disconnect payload is our
 *          real reconnect signal.
 *        - anything else → genuinely disconnected. Log-only; the follow-up
 *          reconnect (whenever it happens) will fire through this same
 *          webhook or /api/webhooks/bison-reconnect and re-enter the flow.
 *
 * One URL per instance:
 *   /api/webhooks/bison-disconnect/outboundhero  (etc.)
 *
 * No signature verification — the URL itself is the secret.
 */

interface BisonDisconnectPayload {
  event?: { type?: string };
  data?: { sender_email?: { id?: number; email?: string; name?: string; status?: string } };
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
  const senderStatusRaw = (payload?.data?.sender_email?.status ?? "").toString();
  const senderStatus = senderStatusRaw.trim().toLowerCase();

  if (senderId === null) {
    console.error(
      `[webhook/disconnect:${instance}] missing data.sender_email.id`,
      JSON.stringify(payload).slice(0, 400),
    );
    return NextResponse.json({ error: "Missing data.sender_email.id" }, { status: 400 });
  }

  // 1. Log the raw disconnect event. Keep this even when the account has
  //    auto-recovered — the audit trail matters (frequency + timing signals
  //    which senders are flaky).
  try {
    const { error } = await getSupabaseAdmin().from("disconnect_events").insert({
      instance,
      sender_id: senderId,
      sender_email: senderEmail,
      sender_name: senderName,
      raw_payload: payload as unknown as Record<string, unknown>,
    });
    if (error) throw new Error(`Supabase insert failed: ${error.message}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "disconnect log failed";
    console.error(`[webhook/disconnect:${instance}]`, message);
    // 500 so Bison retries — a transient DB failure shouldn't lose the event.
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }

  // 2. Bison sometimes fires disconnect on transient auth blips that self-heal
  //    before the webhook arrives. When that happens sender_email.status comes
  //    in already reading "connected". In practice this is the OVERWHELMING
  //    majority of disconnect events — Bison rarely fires an explicit
  //    EMAIL_ACCOUNT_RECONNECTED. Route those through the reconnect helper.
  if (senderStatus === "connected") {
    const result = await handleSenderReconnect({
      instance, senderId, senderEmail,
      source: "webhook_disconnect_auto_recovered",
    });
    console.log(
      `[webhook/disconnect:${instance}] logged sender ${senderId} (${senderEmail ?? "?"}) — auto-recovered, restored ${result.restored} tag(s), queued for conform+attach`,
    );
    return NextResponse.json({
      ok: true,
      instance,
      senderId,
      senderEmail,
      auto_recovered: true,
      restored: result.restored,
      total: result.total,
      note: result.note,
    });
  }

  console.log(
    `[webhook/disconnect:${instance}] logged sender ${senderId} (${senderEmail ?? "?"}) — status=${senderStatusRaw}`,
  );
  return NextResponse.json({
    ok: true,
    instance,
    senderId,
    senderEmail,
    auto_recovered: false,
    sender_status: senderStatusRaw,
  });
}
