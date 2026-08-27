import { NextResponse } from "next/server";
import {
  getAlert,
  bumpRetry,
  resolveAlert,
  recordPipelineAlert,
} from "@/lib/pipeline-alerts";
import { getQueuedByClient } from "@/lib/whitelist-queue";
import { runWhitelistForClient } from "@/lib/whitelist-runner";
import { getConfig, resolveSpreadsheetId } from "@/lib/sheets-config";
import { appendDomainsToSheet } from "@/lib/google-sheets";

export const maxDuration = 120;

// POST /api/pipeline-alerts/retry { id } → re-run the failed pipeline step for
// this alert. Success auto-resolves the alert (box disappears); still-failing
// refreshes the reason and re-pings Slack. Admin-initiated, so the actual send
// only happens on a human click.
export async function POST(request: Request) {
  try {
    const { id } = (await request.json()) as { id?: string };
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

    const alert = await getAlert(id);
    if (!alert || alert.status !== "open") {
      return NextResponse.json({ error: "alert not found or not open" }, { status: 404 });
    }
    await bumpRetry(id);

    if (alert.source === "whitelist-queue" && alert.client_tag) {
      const grouped = await getQueuedByClient();
      const domains = grouped[alert.client_tag] || [];
      if (domains.length === 0) {
        await resolveAlert(id);
        return NextResponse.json({ ok: true, resolved: true, note: "nothing left queued for this client" });
      }
      const r = await runWhitelistForClient(alert.client_tag, domains);
      if (r.failures.length === 0) {
        await resolveAlert(id);
        return NextResponse.json({ ok: true, resolved: true, sentEmails: r.sentEmails, sentDomains: r.sentDomains });
      }
      const f = r.failures[0];
      await recordPipelineAlert({
        source: "whitelist-queue",
        clientTag: alert.client_tag,
        step: f.step,
        reason: f.reason,
        domains: f.domains,
      });
      return NextResponse.json(
        { ok: false, resolved: false, failures: r.failures.map((x) => ({ step: x.step, reason: x.reason, domains: x.domains.length })) },
        { status: 502 },
      );
    }

    if (alert.source === "send-to-sheet" && alert.client_tag) {
      const result = await retryAppendToSheet(alert.client_tag, alert.domains);
      if (result.ok) {
        await resolveAlert(id);
        return NextResponse.json({ ok: true, resolved: true, added: result.added, duplicates: result.duplicates });
      }
      await recordPipelineAlert({
        source: "send-to-sheet",
        clientTag: alert.client_tag,
        step: "append-sheet",
        reason: result.reason || "append failed",
        domains: alert.domains,
      });
      return NextResponse.json({ ok: false, resolved: false, reason: result.reason }, { status: 502 });
    }

    return NextResponse.json({ error: "retry not supported for this alert" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Re-run the "sync to client's Domains tab" step (same logic as send-to-sheet). */
async function retryAppendToSheet(
  clientTag: string,
  domains: string[],
): Promise<{ ok: boolean; added?: number; duplicates?: number; reason?: string }> {
  if (!domains || domains.length === 0) return { ok: true, added: 0, duplicates: 0 };
  const config = await getConfig();
  // Exact tag, then bare prefix before ":" — same rule as send-to-sheet.
  const bare = clientTag.split(":")[0].trim().toUpperCase();
  const tracked =
    config.sheets.find((s) => s.clientTag === clientTag) ??
    config.sheets.find((s) => (s.clientTag || "").split(":")[0].trim().toUpperCase() === bare);
  if (!tracked) return { ok: false, reason: `No tracked sheet found for client tag "${clientTag}"` };
  try {
    const result = await appendDomainsToSheet(resolveSpreadsheetId(tracked), domains);
    return { ok: true, added: result.added, duplicates: result.duplicates };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "append failed" };
  }
}
