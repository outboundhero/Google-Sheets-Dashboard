import { NextResponse } from "next/server";
import { fetchClientRecipients, sendWhitelistEmail } from "@/lib/whitelist-email";
import { getQueuedByClient, markSent } from "@/lib/whitelist-queue";

export const maxDuration = 300;

// Daily whitelist-email batch. Scheduled 6:30 AM PT (14:30 UTC — see vercel.json).
// For each client with queued domains: resolve recipients from ReplyRouter, send
// one email listing ALL queued domains, then mark them sent. A client whose send
// fails or has no recipients is left queued (retries next run) and reported.
export async function GET() {
  try {
    const grouped = await getQueuedByClient();
    const clients = Object.keys(grouped);

    let sentClients = 0;
    let sentDomains = 0;
    const skipped: { clientTag: string; reason: string; domains: number }[] = [];

    for (const clientTag of clients) {
      const domains = grouped[clientTag];
      try {
        const { cc, bcc } = await fetchClientRecipients(clientTag);
        const result = await sendWhitelistEmail({ clientTag, domains, to: cc, bcc });
        if (!result.sent) {
          skipped.push({ clientTag, reason: result.reason || "not sent", domains: domains.length });
          continue;
        }
        await markSent(clientTag, domains);
        sentClients++;
        sentDomains += domains.length;
      } catch (err) {
        skipped.push({
          clientTag,
          reason: err instanceof Error ? err.message : "failed",
          domains: domains.length,
        });
      }
    }

    return NextResponse.json({
      ok: true,
      clients: clients.length,
      sentClients,
      sentDomains,
      skipped,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    console.error("[cron/whitelist-queue]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
