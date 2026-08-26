import { NextResponse } from "next/server";
import { scheduleDeletions } from "@/lib/replacement/duplicate-domains";
import { postSlackMessage } from "@/lib/slack";
import { INSTANCE_SHORT_LABELS, isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";

export const maxDuration = 30;

// POST /api/deliverability/move-finalize — the post-move follow-through the
// move driver calls once a Move-to-Instance run settles (Nick's confirmed #4):
//   • schedule: fully-VERIFIED domains → auto-delete the SOURCE copy after a
//     24h grace (duplicate_domain_deletions, source:"move"; fired by the
//     existing fire-scheduled-deletions cron). Never called for partials.
//   • partials: domains where not every inbox landed → NOTHING is deleted;
//     flagged here via Slack ("Domain X: 9 of 49 inboxes didn't move") and by
//     the dashboard progress panel. Safe to re-run the move to finish them.
// 0 = immediate (Spencer 2026-08-27: "delete all inboxes without fail once
// the system reads that all inboxes have been successfully connected to the
// target instance, instead of waiting 24 hours"). Verification is unchanged
// and still the gate: only domains where EVERY inbox landed get here;
// partials are never deleted. The executor picks the row up on its next
// pass, so "immediate" = minutes, with the row visible (and cancelable) in
// the delete queue until then.
const MOVE_GRACE_DAYS = 0;

const CHANNEL = () =>
  process.env.SLACK_OUTBOUND_CHANNEL_ID ||
  process.env.SLACK_LEAD_SYNC_CHANNEL_ID ||
  undefined; // → postSlackMessage falls back to SLACK_TRIAGE_CHANNEL_ID

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      schedule?: { instance: string; domain: string }[];
      partials?: { domain: string; landed?: number; expected?: number; sourceInstance?: string }[];
      targetInstance?: string;
    };

    const schedule = (body.schedule || []).filter((t) => isInstanceSlug(t.instance) && t.domain);
    const partials = body.partials || [];
    const targetLabel =
      body.targetInstance && isInstanceSlug(body.targetInstance)
        ? INSTANCE_SHORT_LABELS[body.targetInstance as BisonInstanceSlug]
        : body.targetInstance || "target";

    let scheduled = 0;
    if (schedule.length > 0) {
      await scheduleDeletions(schedule, { graceDays: MOVE_GRACE_DAYS, source: "move" });
      scheduled = schedule.length;
    }

    // Slack: one message per run — verified-scheduled summary + per-domain partial lines.
    let slack: { ok: boolean; reason?: string } = { ok: false, reason: "nothing to post" };
    const lines: string[] = [];
    if (scheduled > 0) {
      lines.push(
        `:arrows_counterclockwise: Move to ${targetLabel}: *${scheduled}* domain${scheduled === 1 ? "" : "s"} fully verified — source cop${scheduled === 1 ? "y" : "ies"} ${MOVE_GRACE_DAYS === 0 ? "queued for immediate deletion (next executor pass)" : `auto-delete in ${MOVE_GRACE_DAYS * 24}h`} (cancel from the Duplicate domains card if needed).`,
      );
    }
    if (partials.length > 0) {
      lines.push(`:warning: Move to ${targetLabel} — partial moves, *nothing deleted*, re-run Move to finish:`);
      for (const p of partials.slice(0, 20)) {
        const from = p.sourceInstance && isInstanceSlug(p.sourceInstance) ? ` (from ${INSTANCE_SHORT_LABELS[p.sourceInstance as BisonInstanceSlug]})` : "";
        const missing = typeof p.landed === "number" && typeof p.expected === "number" ? `${p.expected - p.landed} of ${p.expected}` : "some";
        lines.push(`• ${p.domain}${from}: ${missing} inboxes didn't move`);
      }
      if (partials.length > 20) lines.push(`…and ${partials.length - 20} more`);
    }
    if (lines.length > 0) slack = await postSlackMessage(lines.join("\n"), CHANNEL());

    return NextResponse.json({ ok: true, scheduled, partials: partials.length, slack });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
