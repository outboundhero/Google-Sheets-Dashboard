import { NextResponse } from "next/server";
import { fetchClientRecipients, sendWhitelistEmail } from "@/lib/whitelist-email";
import { filterUnsent, markSent, partitionByClientSubTags } from "@/lib/whitelist-queue";

// POST { clientTag, domains[] } → send the whitelist email to this client RIGHT
// NOW, skipping the daily queue. Domains already sent to this client are
// dropped so nobody gets a repeat. Compound client tags are split into one
// email per sub-client (same partition logic as the daily cron).
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

    const { buckets, burnt, unmatched } = await partitionByClientSubTags(clientTag, toSend);
    let sentCount = 0;
    let sentEmails = 0;
    const failures: { subTag: string; reason: string; domains: number }[] = [];
    for (const [subTag, subDomains] of buckets) {
      try {
        const { cc, bcc } = await fetchClientRecipients(subTag);
        const result = await sendWhitelistEmail({ clientTag: subTag, domains: subDomains, to: cc, bcc });
        if (!result.sent) {
          failures.push({ subTag, reason: result.reason || "not sent", domains: subDomains.length });
          continue;
        }
        await markSent(clientTag, subDomains);
        sentEmails++;
        sentCount += subDomains.length;
      } catch (e) {
        failures.push({ subTag, reason: e instanceof Error ? e.message : "failed", domains: subDomains.length });
      }
    }

    const ok = failures.length === 0;
    return NextResponse.json(
      {
        ok,
        clientTag,
        sent: sentEmails > 0,
        sentEmails,
        sentCount,
        skipped,
        burntExcluded: burnt.length,
        unmatched: unmatched.length,
        failures,
      },
      { status: ok ? 200 : 502 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send whitelist email";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
