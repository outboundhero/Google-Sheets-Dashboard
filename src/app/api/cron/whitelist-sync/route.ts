import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { buildWhitelistSyncPlan } from "@/lib/whitelist-sync";
import { enqueueDomains } from "@/lib/whitelist-queue";
import { internalFetch } from "@/lib/replacement/internal-fetch";
import { recordPipelineAlert, resolveAlert } from "@/lib/pipeline-alerts";

export const maxDuration = 300;

// GET /api/cron/whitelist-sync — daily at 13:30 UTC (5:30 AM PT), an hour
// before the whitelist-queue batch. Adds every domain assigned to an active
// client that never reached that client's sheet / whitelist queue (rules in
// src/lib/whitelist-sync.ts).
//
// Writes nothing until WHITELIST_SYNC_ENABLED=true is set in Vercel: the first
// real run appends to client sheets and queues whitelist emails to ~38
// clients, so the list is reviewed first. Until then every run is a report.
// ?dry=1 always reports, whatever the flag.
//
// Clients with no whitelist recipients are flagged on the dashboard (heads-up,
// no Slack) and cleared once ReplyRouter has them.

const RECIPIENT_SOURCE = "whitelist-setup";
const RECIPIENT_STEP = "recipients";
const PACE_MS = 1500;
const BUDGET_MS = 240_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function GET(request: Request) {
  const t0 = Date.now();
  try {
    const dryRun =
      new URL(request.url).searchParams.get("dry") === "1" ||
      process.env.WHITELIST_SYNC_ENABLED !== "true";
    const plan = await buildWhitelistSyncPlan();

    if (dryRun) {
      return NextResponse.json({ dryRun: true, enabled: process.env.WHITELIST_SYNC_ENABLED === "true", ...plan });
    }

    // Recipient setup: one heads-up per client, cleared when fixed.
    const problemTags = new Set(plan.recipientProblems.map((p) => p.clientTag));
    for (const p of plan.recipientProblems) {
      await recordPipelineAlert({
        source: RECIPIENT_SOURCE, clientTag: p.clientTag, step: RECIPIENT_STEP, silent: true,
        reason: `${p.clientTag} is ${p.reason} — its whitelist emails cannot be sent until someone is added there.`,
      }).catch(() => undefined);
    }
    const { data: openSetup } = await getSupabaseAdmin()
      .from("pipeline_alerts").select("id, client_tag").eq("source", RECIPIENT_SOURCE).eq("status", "open");
    for (const a of (openSetup || []) as { id: string; client_tag: string | null }[]) {
      if (a.client_tag && !problemTags.has(a.client_tag)) await resolveAlert(a.id).catch(() => undefined);
    }

    const results: { clientTag: string; sheet: string; added?: number; duplicates?: number; queued?: number; error?: string }[] = [];
    for (const c of plan.clients) {
      if (Date.now() - t0 > BUDGET_MS) { results.push({ clientTag: c.clientTag, sheet: "-", error: "out of time — next run picks it up" }); continue; }
      const row: (typeof results)[number] = { clientTag: c.clientTag, sheet: c.sheetTag ?? "none" };
      // Sheet first; a failed append records its own alert inside the route
      // and must not stop the whitelist queue.
      if (c.sheetTag) {
        try {
          const res = await internalFetch("/api/deliverability/send-to-sheet", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ domains: c.domains, clientTag: c.sheetTag }),
          });
          const j = (await res.json().catch(() => ({}))) as { added?: number; duplicates?: number; error?: string };
          if (!res.ok) row.error = `sheet: ${j.error ?? res.status}`;
          else { row.added = j.added; row.duplicates = j.duplicates; }
        } catch (e) {
          row.error = `sheet: ${e instanceof Error ? e.message : "failed"}`;
        }
      } else {
        await recordPipelineAlert({
          source: "send-to-sheet", clientTag: c.clientTag, step: "find-sheet", domains: c.domains,
          reason: `No tracked sheet found for client tag "${c.clientTag}" (whitelist sync)`,
        }).catch(() => undefined);
        row.error = "no tracked sheet";
      }
      try {
        row.queued = (await enqueueDomains(c.clientTag, c.domains)).queued;
      } catch (e) {
        row.error = `${row.error ? `${row.error}; ` : ""}queue: ${e instanceof Error ? e.message : "failed"}`;
      }
      results.push(row);
      await sleep(PACE_MS);
    }

    return NextResponse.json({
      dryRun: false,
      activeClients: plan.activeClients,
      clients: results.length,
      domains: plan.totalDomains,
      queued: results.reduce((s, r) => s + (r.queued ?? 0), 0),
      recipientProblems: plan.recipientProblems,
      results,
      durationMs: Date.now() - t0,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "whitelist-sync failed";
    console.error("[cron/whitelist-sync]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
