import { NextResponse } from "next/server";
import { postSlackMessage } from "@/lib/slack";

// POST /api/replacement/notify-failure — Slack notification when a replacement
// run had failed/degraded steps. Notify-only by design (Spencer + user
// 2026-07-29): the RETRY lives in LeadSync (Replacement → "Failed steps —
// retry" card), not as a Slack button. Admin-only via middleware.

/** Same default mentions + channel chain as the low-domain alert. */
function mentionPrefix(): string {
  const ids = (process.env.SLACK_LOW_DOMAIN_MENTIONS || "U070H18FNLA,U06UYNAV01X")
    .split(",").map((s) => s.trim()).filter(Boolean);
  return ids.map((id) => `<@${id}>`).join(" ");
}
function channelId(): string | undefined {
  return process.env.SLACK_REPLACEMENT_REPORT_CHANNEL_ID
    || process.env.SLACK_OUTBOUND_CHANNEL_ID
    || process.env.SLACK_LEAD_SYNC_CHANNEL_ID
    || "C0B84LMSVMH";
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      clientTag?: string;
      instance?: string;
      steps?: { label: string; state: string; note?: string }[];
    };
    const steps = body.steps ?? [];
    if (!body.clientTag || steps.length === 0) {
      return NextResponse.json({ error: "clientTag and steps are required" }, { status: 400 });
    }
    const lines = [
      `*⚠️ Replacement run issues — ${body.clientTag}${body.instance ? ` (${body.instance})` : ""}* ${mentionPrefix()}`,
      `${steps.length} step${steps.length === 1 ? "" : "s"} did not fully complete:`,
      ...steps.slice(0, 15).map((s) => `• ${s.label} — *${s.state}*${s.note ? ` (${s.note})` : ""}`),
      "_Retry from LeadSync → Replacement → “Failed steps — retry”._",
    ];
    const slack = await postSlackMessage(lines.join("\n"), channelId());
    return NextResponse.json({ ok: slack.ok, reason: slack.reason });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
