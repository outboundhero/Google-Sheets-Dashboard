// Per-CLIENT low-domain Slack alert (Spencer's Loom, 2026-07-27): "this client
// is under 20" — for every (client tag, instance) whose HEALTHY domain count is
// below its cap (20 B2B / 5 B2C), post one morning summary to Slack with
// @mentions. READ-ONLY + notify — executes nothing on Bison or any provider.
// Fired weekdays 8am PT by cron; also runnable on demand (?force / ?dry).
//
// Healthy = domains that STAY after burnt ones are removed (the plan's cap
// baseline). When the segmented threshold groups are enabled, THEY decide what's
// burnt — same detector Spencer is testing — otherwise the flat guardrails do.
import { buildReplacementPlan } from "./plan";
import { getThresholdConfig } from "./threshold-groups-store";
import { getActiveCampaignKeys } from "./campaigns";
import { postSlackMessage } from "@/lib/slack";
import { getInstance, type BisonInstanceSlug } from "@/lib/bison-instances";

const TOP_N = 5;        // worst shortfalls shown in the channel message
const CHUNK_LINES = 40; // full-list lines per thread reply (stays well under Slack limits)

export interface LowDomainClient {
  clientTag: string;
  instance: string;
  tier: string;
  healthy: number;   // domains that stay (non-burnt)
  total: number;     // all domains currently assigned
  capMax: number;    // 20 b2b | 5 b2c
  short: number;     // capMax − healthy
}

export interface LowDomainAlertResult {
  checkedAt: string;
  detector: "groups" | "guardrails";
  clientsChecked: number;
  lowCount: number;
  /** (tag, instance) pairs under cap but with no active campaign there — ghost
   *  pairs (leftover setups, wrong-group tags). Hidden from the list so the
   *  alert reads real shortfalls only (Spencer, 2026-08-24: JPCO double-count). */
  ghostPairs: number;
  alerted: boolean;
  slackReason?: string;
  low: LowDomainClient[];
}

/** `<@U…>` mention prefix from SLACK_LOW_DOMAIN_MENTIONS (comma-separated member
 *  IDs). Default = Nick + Spencer. */
function mentionPrefix(): string {
  const ids = (process.env.SLACK_LOW_DOMAIN_MENTIONS || "U070H18FNLA,U06UYNAV01X")
    .split(",").map((s) => s.trim()).filter(Boolean);
  return ids.map((id) => `<@${id}>`).join(" ");
}

/** Channel: own env first, then the shared LeadSync-Outbound channel chain. */
function channelId(): string | undefined {
  return process.env.SLACK_LOW_DOMAIN_CHANNEL_ID
    || process.env.SLACK_OUTBOUND_CHANNEL_ID
    || process.env.SLACK_LEAD_SYNC_CHANNEL_ID
    || "C0B84LMSVMH";
}

export async function checkLowDomainClients(
  opts: { force?: boolean; dryRun?: boolean } = {},
): Promise<LowDomainAlertResult> {
  // use the segmented groups as the burnt detector when they're enabled —
  // keeps this alert consistent with whatever detection is being tested/live
  const groupCfg = await getThresholdConfig();
  const detector = groupCfg.enabled ? "groups" as const : "guardrails" as const;
  const plan = await buildReplacementPlan(
    detector === "groups" ? { burntSource: "groups", groupConfig: groupCfg } : {},
  );

  const allLow: LowDomainClient[] = plan.clientAudit
    .map((a) => ({
      clientTag: a.clientTag,
      instance: a.instance,
      tier: getInstance(a.instance as BisonInstanceSlug).tier,
      healthy: a.staying,
      total: a.total,
      capMax: a.capMax,
      short: a.capMax - a.staying,
    }))
    .filter((c) => c.short > 0)
    .sort((x, y) => y.short - x.short || x.clientTag.localeCompare(y.clientTag));

  // A pair with no active campaign in that instance isn't short — nothing is
  // sending there to be short FOR (JPCO's leftover Group-2 copies made the
  // topline read 78 when the real number was lower). Same rule the buy digest
  // uses, so the two alerts agree on what counts.
  const activeKeys = await getActiveCampaignKeys();
  const low = allLow.filter((c) =>
    activeKeys.has(`${c.clientTag.trim().toUpperCase()}:${c.instance}`),
  );
  const ghostPairs = allLow.length - low.length;

  const checkedAt = new Date().toISOString();
  const base = { checkedAt, detector, clientsChecked: plan.clientAudit.length, lowCount: low.length, ghostPairs, low };

  if (low.length === 0 && !opts.force) return { ...base, alerted: false };
  if (opts.dryRun) return { ...base, alerted: false, slackReason: "dry run" };

  // channel message = short summary (worst TOP_N); the FULL list goes in the
  // thread so the channel isn't flooded and nothing is truncated away.
  const mentions = mentionPrefix();
  const line = (c: LowDomainClient) =>
    `• *${c.clientTag}* (${c.instance}, ${c.tier}): ${c.healthy} of ${c.capMax} — short *${c.short}*`;

  const main: string[] = [
    `*🔻 Clients under domain cap — LeadSync*${mentions ? ` ${mentions}` : ""}`,
  ];
  if (low.length === 0) {
    main.push("_(forced test — every client is at cap)_");
  } else {
    main.push(`*${low.length}* client${low.length === 1 ? "" : "s"} below cap (healthy domains after burnt are removed). Worst ${Math.min(TOP_N, low.length)}:`);
    for (const c of low.slice(0, TOP_N)) main.push(line(c));
    if (low.length > TOP_N) main.push(`🧵 Full list of all ${low.length} in the thread`);
  }
  if (ghostPairs > 0) {
    main.push(`_${ghostPairs} pair${ghostPairs === 1 ? "" : "s"} hidden — no active campaigns in that instance (leftover setups, not real shortfalls)_`);
  }
  main.push(`_Detector: ${detector} · observe-only, nothing was changed_`);

  const channel = channelId();
  const slack = await postSlackMessage(main.join("\n"), channel);
  if (!slack.ok) return { ...base, alerted: false, slackReason: slack.reason };

  // full list as thread replies, chunked
  let threadReason: string | undefined;
  if (low.length > TOP_N && slack.ts) {
    for (let i = 0; i < low.length; i += CHUNK_LINES) {
      const chunk = low.slice(i, i + CHUNK_LINES).map(line).join("\n");
      const reply = await postSlackMessage(chunk, channel, { threadTs: slack.ts });
      if (!reply.ok) { threadReason = `thread reply failed: ${reply.reason}`; break; }
    }
  }
  return { ...base, alerted: true, slackReason: threadReason };
}
