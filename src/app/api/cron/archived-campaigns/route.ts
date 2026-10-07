import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { findArchivedCampaigns } from "@/lib/campaigns/archived-check";
import { recordPipelineAlert, resolveAlert, pipelineAlertChannel } from "@/lib/pipeline-alerts";
import { postSlackMessage } from "@/lib/slack";
import { BISON_INSTANCES } from "@/lib/bison-instances";

export const maxDuration = 300;

// GET /api/cron/archived-campaigns — every 6 hours, 20 min after the last
// instance's campaign sync. Flags archived Main / Nurture campaigns on clients
// that are still active (rules in src/lib/campaigns/archived-check.ts).
//
// Spencer 2026-10-07: SINY's B2C #2 "Google + Custom" and "SEGs" were archived
// for two weeks while the client was active, and nothing flagged them.
// Completed campaigns are already revived by revive-completed; archived ones
// need a person, so this only reports — one dashboard row per client +
// instance, cleared automatically once the campaign is unarchived.
//
// Slack: one digest a day (the 12:50 UTC run), and only once
// ARCHIVED_CAMPAIGNS_SLACK_ENABLED=true is set — muted until the message is
// approved. ?dry=1 returns the findings without writing anything; ?slack=1
// sends the digest on any run (still needs the env flag).

const SOURCE = "campaign-archived";
const SLACK_HOUR_UTC = 12;

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const dryRun = params.get("dry") === "1";
    const result = await findArchivedCampaigns();

    const label = (inst: string) => BISON_INSTANCES[inst as keyof typeof BISON_INSTANCES]?.label ?? inst;
    const reasonFor = (f: (typeof result.findings)[number]) =>
      `archived on ${label(f.instance)} while the client is active: ` +
      f.campaigns.map((c) => `"${c.name}" (#${c.id}, ${c.stage} ${c.role}${c.verified ? "" : ", not re-checked"})`).join("; ") +
      ". Revive it in Bison, or dismiss if it was archived on purpose.";

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        clientsChecked: result.clientsChecked,
        flagged: result.findings.length,
        findings: result.findings.map((f) => ({ ...f, reason: reasonFor(f) })),
        alreadyRevived: result.alreadyRevived,
      });
    }

    // One alert per client + instance; recordPipelineAlert dedupes on
    // (source, client, step) and refreshes the reason in place.
    const flaggedKeys = new Set<string>();
    for (const f of result.findings) {
      const step = `archived:${f.instance}`;
      flaggedKeys.add(`${f.clientTag}|${step}`);
      await recordPipelineAlert({ source: SOURCE, clientTag: f.clientTag, step, reason: reasonFor(f), silent: true });
    }

    // Anything flagged before but not now has been revived (or the client
    // stopped being active) — clear it.
    const { data: open } = await getSupabaseAdmin()
      .from("pipeline_alerts")
      .select("id, client_tag, step")
      .eq("source", SOURCE)
      .eq("status", "open");
    let resolved = 0;
    for (const a of (open || []) as { id: string; client_tag: string | null; step: string }[]) {
      if (!flaggedKeys.has(`${a.client_tag}|${a.step}`)) {
        await resolveAlert(a.id);
        resolved++;
      }
    }

    let slack: { ok: boolean; reason?: string } = { ok: false, reason: "not the daily slot" };
    const slackDue = params.get("slack") === "1" || new Date().getUTCHours() === SLACK_HOUR_UTC;
    if (slackDue && result.findings.length > 0) {
      if (process.env.ARCHIVED_CAMPAIGNS_SLACK_ENABLED !== "true") {
        slack = { ok: false, reason: "muted (set ARCHIVED_CAMPAIGNS_SLACK_ENABLED=true to send)" };
      } else {
        const lines = result.findings.map((f) =>
          `• *${f.clientTag}* on ${label(f.instance)}: ${f.campaigns.map((c) => `${c.name} (#${c.id})`).join(", ")}`,
        );
        slack = await postSlackMessage(
          [`:file_cabinet: *Archived campaigns on active clients* (${result.findings.length})`, ...lines,
            "Revive them in Bison, or dismiss on the LeadSync dashboard if archived on purpose."].join("\n"),
          pipelineAlertChannel(),
        );
      }
    }

    return NextResponse.json({
      clientsChecked: result.clientsChecked,
      flagged: result.findings.length,
      resolved,
      alreadyRevived: result.alreadyRevived.length,
      slack,
      findings: result.findings,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "archived-campaigns failed";
    console.error("[cron/archived-campaigns]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
