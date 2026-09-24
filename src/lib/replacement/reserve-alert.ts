// Reserve-shortage Slack alert. Builds the replacement plan and posts a Slack
// summary when any instance is low on ready reserve, or when burnt domains can't
// be replaced because the reserve is empty. READ-ONLY + notify — executes nothing
// on Bison or any provider. Fires from a daily cron; also runnable on demand.
import { buildReplacementPlan } from "./plan";
import { postSlackMessage } from "@/lib/slack";
import { getStockCounts } from "./stock-counts";
import { getSupabaseAdmin } from "@/lib/supabase";
import { ALL_INSTANCE_SLUGS, getInstance, INSTANCE_SHORT_LABELS } from "@/lib/bison-instances";

/** Below this many pull-able reserve domains, an instance is "low". Env-tunable. */
const LOW_RESERVE_FLOOR = Math.max(0, Number(process.env.RESERVE_MIN_READY ?? 5));
const RESERVE_BLOCKER_RE = /no ready .* reserve/i;

export interface ReserveAlertResult {
  checkedAt: string;
  hasIssue: boolean;
  alerted: boolean;
  slackReason?: string;
  floor: number;
  low: { instance: string; tier: string; ready: number; warming: number; warmingReady7: number; inflight: number }[];
  blockedByReserve: { instance: string; count: number }[];
  totalBlocked: number;
}

export async function checkReserveAndAlert(opts: { force?: boolean; dryRun?: boolean } = {}): Promise<ReserveAlertResult & { preview?: string }> {
  const plan = await buildReplacementPlan({ infoMigration: false });

  // Stock on hand that is not "ready" yet — warming in Bison and orders in
  // flight. Vicky 2026-09-18: "4 ready" on CO read as "buy more" while 20+
  // B2C domains were days from crossing the 21-day line and the buy list
  // said 0. Same gates as the buy list, so the two never disagree.
  const stock = await getStockCounts(await knownClientTags());

  // low reserve per instance (pull-able = outlook + google)
  const low: ReserveAlertResult["low"] = [];
  for (const inst of ALL_INSTANCE_SLUGS) {
    const r = plan.reserveReadyByInstance[inst];
    const ready = (r?.outlook ?? 0) + (r?.google ?? 0);
    if (ready < LOW_RESERVE_FLOOR) {
      low.push({
        instance: inst, tier: getInstance(inst).tier, ready,
        warming: stock.warming[inst] ?? 0, warmingReady7: stock.warmingReady7[inst] ?? 0, inflight: stock.inflight[inst] ?? 0,
      });
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

  if (!hasIssue && !opts.force && !opts.dryRun) return { ...base, alerted: false };

  // Shaped like the weekly buy list Spencer asked us to match (2026-09-24):
  // one line per instance, the number first, the detail only where it changes
  // what he does. The old format listed only the low instances with four
  // figures each, which read as a wall of numbers.
  const lowBySlug = new Map(low.map((l) => [l.instance, l]));
  const blockedBySlug = new Map(blockedByReserve.map((b) => [b.instance, b.count]));
  const lines: string[] = ["*🟠 Reserve ready — LeadSync domain replacement*"];
  lines.push("Domains ready to pull for replacements:");
  for (const slug of ALL_INSTANCE_SLUGS) {
    const l = lowBySlug.get(slug);
    const ready = l ? l.ready : (plan.reserveReadyByInstance[slug]?.total ?? 0);
    const extras: string[] = [];
    if (l && l.warming > 0) extras.push(`${l.warming} warming (${l.warmingReady7} ready within 7 days)`);
    if (l && l.inflight > 0) extras.push(`${l.inflight} on order`);
    const blocked = blockedBySlug.get(slug) ?? 0;
    if (blocked > 0) extras.push(`*${blocked} burnt waiting*`);
    lines.push(`• ${INSTANCE_SHORT_LABELS[slug]}: ${ready}${extras.length ? ` — ${extras.join(" · ")}` : ""}`);
  }
  const covered = low.length > 0 && low.every((l) => l.ready + l.warming + l.inflight >= LOW_RESERVE_FLOOR);
  if (!hasIssue) lines.push("_(forced test — no actual issue)_");
  else if (totalBlocked > 0) lines.push(`${totalBlocked} burnt domain${totalBlocked === 1 ? "" : "s"} can't be replaced yet — nothing ready to swap in.`);
  else if (covered) lines.push("Warming stock and open orders cover this — nothing to buy.");
  else lines.push(`Below ${LOW_RESERVE_FLOOR} ready — buy and warm more so replacements never stall.`);
  lines.push("_Nothing was bought or changed — this is a status check._");

  // #leadsync-outbound (Spencer confirmed 2026-07-29) via the shared chain
  const channel = process.env.SLACK_RESERVE_CHANNEL_ID
    || process.env.SLACK_OUTBOUND_CHANNEL_ID
    || process.env.SLACK_LEAD_SYNC_CHANNEL_ID
    || "C0B84LMSVMH";
  // ?dry=1 renders the message without posting — the true-up-move lesson.
  if (opts.dryRun) return { ...base, alerted: false, slackReason: "dry run", preview: lines.join("\n") };
  const slack = await postSlackMessage(lines.join("\n"), channel);
  return { ...base, alerted: slack.ok, slackReason: slack.reason };
}

/** Every client tag the campaigns table knows — the "has a client" gate stock-counts uses. */
async function knownClientTags(): Promise<Set<string>> {
  const supabase = getSupabaseAdmin();
  const out = new Set<string>();
  for (let off = 0; ; off += 1000) {
    const { data, error } = await supabase
      .from("campaigns")
      .select("client_tag")
      .order("id", { ascending: true })
      .range(off, off + 999);
    if (error) throw new Error(`campaigns: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data as { client_tag: string | null }[]) {
      const t = (r.client_tag || "").trim().toUpperCase();
      if (t) out.add(t);
    }
    if (data.length < 1000) break;
  }
  return out;
}
