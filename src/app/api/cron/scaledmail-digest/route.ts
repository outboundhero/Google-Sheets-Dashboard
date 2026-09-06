import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { postSlackMessage } from "@/lib/slack";

// Once-daily ScaledMail manual-cancel digest (Nick 2026-09-02, spam-fixed
// 2026-09-03: the per-run post fired every 15 minutes during a drain).
// ScaledMail has no cancel API — cancelled domains are collected as events by
// the fire-scheduled-cancellations worker; this cron rolls the last day's
// batch into ONE copy-paste message, and posts nothing on empty days.
export const maxDuration = 60;

const LOOKBACK_H = 26; // daily cron + 2h slack so a delayed run drops nothing

export async function GET() {
  try {
    const supabase = getSupabaseAdmin();
    const since = new Date(Date.now() - LOOKBACK_H * 3600_000).toISOString();
    const { data, error } = await supabase
      .from("replacement_events")
      .select("domain")
      .eq("event_type", "skipped")
      .ilike("detail", "scaledmail manual-cancel needed%")
      .gte("created_at", since)
      .limit(500);
    if (error) throw new Error(error.message);

    const domains = [...new Set((data || []).map((r) => r.domain))].sort();
    if (domains.length === 0) return NextResponse.json({ posted: false, domains: 0 });

    const channel =
      process.env.SLACK_OUTBOUND_CHANNEL_ID ||
      process.env.SLACK_LEAD_SYNC_CHANNEL_ID ||
      undefined; // → postSlackMessage falls back to SLACK_TRIAGE_CHANNEL_ID
    const text =
      `📋 ScaledMail manual cancels needed (${domains.length}) — copy-paste for their Slack:\n` +
      domains.map((d) => `• ${d}`).join("\n") +
      `\n_Senders are already deleted from Bison; this is only the vendor-side cancellation._`;
    const r = await postSlackMessage(text, channel);
    return NextResponse.json({ posted: r.ok, domains: domains.length, reason: r.reason });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
