import { NextResponse } from "next/server";
import { fetchClientRecipients, sendWhitelistEmail } from "@/lib/whitelist-email";
import { getQueuedByClient, markSent, partitionByClientSubTags } from "@/lib/whitelist-queue";

export const maxDuration = 300;

// Daily whitelist-email batch. Scheduled 6:30 AM PT (14:30 UTC — see vercel.json).
//
// For each client with queued domains: partition into per-recipient buckets
// (compound tags like "DBSM / DBSA / DBSNJ / DBSF" split into one bucket per
// sub-client, matched by each domain's own Bison tag — ReplyRouter has no
// client under the compound name), resolve each bucket's recipients from
// ReplyRouter, send one email per bucket listing its domains, then mark them
// sent. Failures / missing recipients leave the domains queued (retried next
// run) and are reported. Burnt-tagged domains are dropped from the queue
// without emailing — whitelisting a retiring domain is noise.
export async function GET() {
  try {
    const grouped = await getQueuedByClient();
    const clients = Object.keys(grouped);

    let sentEmails = 0;
    let sentDomains = 0;
    let burntDropped = 0;
    const skipped: { clientTag: string; reason: string; domains: number }[] = [];

    for (const clientTag of clients) {
      const domains = grouped[clientTag];
      try {
        const { buckets, burnt, unmatched } = await partitionByClientSubTags(clientTag, domains);

        if (burnt.length > 0) {
          // Clear them from the queue (marked sent) so they stop clogging runs.
          await markSent(clientTag, burnt);
          burntDropped += burnt.length;
        }
        if (unmatched.length > 0) {
          skipped.push({ clientTag, reason: "no sub-client tag on domain — left queued", domains: unmatched.length });
        }

        for (const [subTag, subDomains] of buckets) {
          try {
            const { cc, bcc } = await fetchClientRecipients(subTag);
            const result = await sendWhitelistEmail({ clientTag: subTag, domains: subDomains, to: cc, bcc });
            if (!result.sent) {
              skipped.push({ clientTag: subTag === clientTag ? clientTag : `${clientTag} → ${subTag}`, reason: result.reason || "not sent", domains: subDomains.length });
              continue;
            }
            await markSent(clientTag, subDomains);
            sentEmails++;
            sentDomains += subDomains.length;
          } catch (err) {
            skipped.push({
              clientTag: subTag === clientTag ? clientTag : `${clientTag} → ${subTag}`,
              reason: err instanceof Error ? err.message : "failed",
              domains: subDomains.length,
            });
          }
        }
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
      sentEmails,
      sentDomains,
      burntDropped,
      skipped,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    console.error("[cron/whitelist-queue]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
