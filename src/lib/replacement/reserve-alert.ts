// Reserve-shortage Slack alert. Builds the replacement plan and posts a Slack
// summary when any instance is low on ready reserve, or when burnt domains can't
// be replaced because the reserve is empty. READ-ONLY + notify — executes nothing
// on Bison or any provider. Fires from a daily cron; also runnable on demand.
import { buildReplacementPlan } from "./plan";
import { postSlackMessage } from "@/lib/slack";
import { ALL_INSTANCE_SLUGS, getInstance } from "@/lib/bison-instances";

/** Below this many pull-able reserve domains, an instance is "low". Env-tunable. */
const LOW_RESERVE_FLOOR = Math.max(0, Number(process.env.RESERVE_MIN_READY ?? 5));
const RESERVE_BLOCKER_RE = /no ready .* reserve/i;

export interface ReserveAlertResult {
  checkedAt: string;
  hasIssue: boolean;
  alerted: boolean;
  slackReason?: string;
  floor: number;
  low: { instance: string; tier: string; ready: number }[];
  blockedByReserve: { instance: string; count: number }[];
  totalBlocked: number;
}

export async function checkReserveAndAlert(opts: { force?: boolean } = {}): Promise<ReserveAlertResult> {
  const plan = await buildReplacementPlan({ infoMigration: false });

  // low reserve per instance (pull-able = outlook + google)
  const low: ReserveAlertResult["low"] = [];
  for (const inst of ALL_INSTANCE_SLUGS) {
    const r = plan.reserveReadyByInstance[inst];
    const ready = (r?.outlook ?? 0) + (r?.google ?? 0);
    if (ready < LOW_RESERVE_FLOOR) {
      low.push({ instance: inst, tier: getInstance(inst).tier, ready });
    }
  }

  // burnt domains that WANTED a replacement but were blocked by an empty reserve
  const blockedMap = new Map<string, number>();
  for (const it of plan.items) {
    if (it.removeOnly) continue;
    if (it.blockers.some((b) => RESERVE_BLOCKER_RE.test(b))) {
      blockedMap.set(it.instance, (blockedMap.get(it.instance) || 0) + 1);
    }
  }
  const blockedByReserve = [...blockedMap.entries()].map(([instance, count]) => ({ instance, count }));
  const totalBlocked = blockedByReserve.reduce((s, b) => s + b.count, 0);

  const hasIssue = low.length > 0 || totalBlocked > 0;
  const checkedAt = new Date().toISOString();
  const base = { checkedAt, hasIssue, floor: LOW_RESERVE_FLOOR, low, blockedByReserve, totalBlocked };

  if (!hasIssue && !opts.force) return { ...base, alerted: false };

  const lines: string[] = ["*🟠 Reserve alert — LeadSync domain replacement*"];
  if (totalBlocked > 0) {
    lines.push(`• *${totalBlocked}* burnt domain${totalBlocked === 1 ? "" : "s"} can't be replaced — no ready reserve:`);
    for (const b of blockedByReserve) lines.push(`    – ${b.instance}: ${b.count}`);
  }
  if (low.length > 0) {
    lines.push(`• Low reserve (< ${LOW_RESERVE_FLOOR} ready):`);
    for (const l of low) lines.push(`    – ${l.instance} (${l.tier}): ${l.ready} ready`);
  }
  if (!hasIssue) lines.push("_(forced test — no actual issue)_");
  else lines.push("Buy + warm more domains so replacements never stall.");

  // #leadsync-outbound (Spencer confirmed 2026-07-29) via the shared chain
  const channel = process.env.SLACK_RESERVE_CHANNEL_ID
    || process.env.SLACK_OUTBOUND_CHANNEL_ID
    || process.env.SLACK_LEAD_SYNC_CHANNEL_ID
    || "C0B84LMSVMH";
  const slack = await postSlackMessage(lines.join("\n"), channel);
  return { ...base, alerted: slack.ok, slackReason: slack.reason };
}
