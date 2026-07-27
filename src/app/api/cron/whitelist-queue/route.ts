import { NextResponse } from "next/server";
import { getQueuedByClient } from "@/lib/whitelist-queue";
import { runWhitelistForClient } from "@/lib/whitelist-runner";
import { recordPipelineAlert, resolveAlertsForClients } from "@/lib/pipeline-alerts";

export const maxDuration = 300;

// Daily whitelist-email batch. Scheduled 6:30 AM PT (14:30 UTC — see vercel.json).
//
// For each client with queued domains, runWhitelistForClient partitions into
// per-recipient buckets (compound tags split into one bucket per sub-client;
// the ": Leads" suffix stripped so ReplyRouter resolves), sends one email per
// bucket, and marks those domains sent. Any failed step is recorded to
// pipeline_alerts AND pinged to #leadsync-outbound — never silently skipped
// like the 7/15 batch. A client that fully succeeds clears its open alert.
export async function GET() {
  try {
    const grouped = await getQueuedByClient();
    const clients = Object.keys(grouped);

    let sentEmails = 0;
    let sentDomains = 0;
    let burntDropped = 0;
    const skipped: { clientTag: string; step: string; reason: string; domains: number }[] = [];
    const recovered: string[] = [];

    for (const clientTag of clients) {
      const r = await runWhitelistForClient(clientTag, grouped[clientTag]);
      sentEmails += r.sentEmails;
      sentDomains += r.sentDomains;
      burntDropped += r.burntDropped;

      for (const f of r.failures) {
        skipped.push({
          clientTag: f.subTag === clientTag ? clientTag : `${clientTag} → ${f.subTag}`,
          step: f.step,
          reason: f.reason,
          domains: f.domains.length,
        });
        await recordPipelineAlert({
          source: "whitelist-queue",
          clientTag, // keep the stored tag as the dedup key
          step: f.step,
          reason: f.reason,
          domains: f.domains,
        });
      }

      if (r.failures.length === 0) recovered.push(clientTag);
    }

    // Clients that fully sent this run get their open alert closed automatically.
    await resolveAlertsForClients("whitelist-queue", recovered);

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
    // A top-level crash is itself a loud failure — record it so it's visible.
    await recordPipelineAlert({ source: "whitelist-queue", step: "cron", reason: message }).catch(() => {});
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
