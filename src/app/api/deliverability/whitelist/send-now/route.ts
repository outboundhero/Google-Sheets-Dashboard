import { NextResponse } from "next/server";
import { fetchClientRecipients, sendWhitelistEmail } from "@/lib/whitelist-email";
import { filterUnsent, markSent } from "@/lib/whitelist-queue";

// POST { clientTag, domains[] } → send the whitelist email to this client RIGHT
// NOW (the renamed "Whitelist" button), skipping the daily queue. Domains
// already sent to this client are dropped so nobody gets a repeat.
export async function POST(request: Request) {
  try {
    const { clientTag, domains } = (await request.json()) as {
      clientTag?: string;
      domains?: string[];
    };
    if (!clientTag || !Array.isArray(domains) || domains.length === 0) {
      return NextResponse.json({ error: "clientTag and domains are required" }, { status: 400 });
    }

    const toSend = await filterUnsent(clientTag, domains);
    const skipped = domains.length - toSend.length;
    if (toSend.length === 0) {
      return NextResponse.json({ ok: true, clientTag, sent: false, sentCount: 0, skipped, reason: "all domains already whitelisted for this client" });
    }

    const { cc, bcc } = await fetchClientRecipients(clientTag);
    const result = await sendWhitelistEmail({ clientTag, domains: toSend, to: cc, bcc });

    if (!result.sent) {
      // Don't mark as sent — leave it so it can be retried / queued.
      return NextResponse.json(
        { ok: false, clientTag, sent: false, sentCount: 0, skipped, recipients: { to: cc.length, bcc: bcc.length }, reason: result.reason },
        { status: 502 },
      );
    }

    await markSent(clientTag, toSend);
    return NextResponse.json({
      ok: true,
      clientTag,
      sent: true,
      sentCount: toSend.length,
      skipped,
      recipients: { to: cc.length, bcc: bcc.length },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send whitelist email";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
