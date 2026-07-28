// Minimal Slack notifier via chat.postMessage. Requires a bot token with the
// chat:write scope (SLACK_BOT_TOKEN) and the bot to be a member of the target
// channel (SLACK_TRIAGE_CHANNEL_ID). No-ops gracefully until both are set.
export async function postSlackMessage(
  text: string,
  channelOverride?: string,
  opts: { threadTs?: string } = {},
): Promise<{ ok: boolean; reason?: string; ts?: string }> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = channelOverride || process.env.SLACK_TRIAGE_CHANNEL_ID;
  if (!token || !channel) {
    return { ok: false, reason: "Slack not configured (SLACK_BOT_TOKEN / SLACK_TRIAGE_CHANNEL_ID)" };
  }
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel, text, ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}) }),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; ts?: string };
    if (!json.ok) return { ok: false, reason: json.error || `HTTP ${res.status}` };
    return { ok: true, ts: json.ts };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "request failed" };
  }
}
