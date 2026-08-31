// Weekly "buy this many domains per instance" Slack digest (Spencer/Nick,
// 2026-08-05). Purchasing stays MANUAL — this only tells Nick how many domains
// (and inboxes) to order per instance so nobody has to open the dashboard.
// Mirrors the tier-aware numbers on the /replacement "Domains short" card exactly
// (live caps 20/40 B2B · 5/10 B2C from Client Tracker col K). READ-ONLY: buys
// nothing. Fires weekly by cron; ?dry returns the numbers WITHOUT posting to
// Slack, ?force posts even when nothing is short.
import { buildReplacementPlan } from "./plan";
import { getThresholdConfig } from "./threshold-groups-store";
import { getActiveCampaignKeys } from "./campaigns";
import { capFor, getClientTiers, type ClientTier } from "./client-tiers";
import { getGoingLiveForecast } from "./going-live";
import { getTaggedDomainCounts } from "./upcoming-stock";
import { postSlackMessage } from "@/lib/slack";
import {
  ALL_INSTANCE_SLUGS, getInstance, INSTANCE_SHORT_LABELS,
  type BisonInstanceSlug, type BisonGroup, type BisonTier,
} from "@/lib/bison-instances";

const MAILBOXES_PER_DOMAIN = 49; // Inboxing standard order size (matches purchase-proposal.ts)

export interface BuyInstanceLine {
  instance: BisonInstanceSlug;
  label: string;
  tier: BisonTier;
  clientsShort: number;
  domains: number; // domains to buy = Σ shortfall-to-live-cap across this instance's tags
  inboxes: number; // domains × 49
  /** Of `domains`, how many are launch stock for upcoming start-date clients. */
  upcomingDomains: number;
  upcomingClients: number;
}
export interface BuyAlertResult {
  checkedAt: string;
  detector: "groups" | "guardrails";
  tierSource: "client-tracker" | "default-tier-1";
  totalDomains: number;
  totalInboxes: number;
  byInstance: BuyInstanceLine[];
  alerted: boolean;
  slackReason?: string;
}

/** `<@U…>` mention prefix from SLACK_BUY_ALERT_MENTIONS (comma-separated member
 *  IDs). Default = Nick (he handles purchasing). */
function mentionPrefix(): string {
  const ids = (process.env.SLACK_BUY_ALERT_MENTIONS || "U070H18FNLA")
    .split(",").map((s) => s.trim()).filter(Boolean);
  return ids.map((id) => `<@${id}>`).join(" ");
}

/** Channel: the dedicated #domain-buying var first, then the shared chain. */
function channelId(): string | undefined {
  return process.env.SLACK_DOMAIN_BUYING_CHANNEL_ID
    || process.env.SLACK_OUTBOUND_CHANNEL_ID
    || process.env.SLACK_LEAD_SYNC_CHANNEL_ID
    || "C0B84LMSVMH";
}

export async function runBuyAlert(opts: { force?: boolean; dryRun?: boolean } = {}): Promise<BuyAlertResult> {
  const cfg = await getThresholdConfig();
  const useGroups = cfg.enabled;
  const [plan, tiers, activeKeys] = await Promise.all([
    buildReplacementPlan(useGroups ? { burntSource: "groups", groupConfig: cfg, infoMigration: false } : { infoMigration: false }),
    getClientTiers(),
    getActiveCampaignKeys(),
  ]);

  // ── per-instance shortfall (mirrors /api/replacement/shortfall `byInstance`) ──
  // group → its b2b + b2c instance slug
  const groupSlug = new Map<BisonGroup, { b2b: BisonInstanceSlug; b2c: BisonInstanceSlug }>();
  for (const slug of ALL_INSTANCE_SLUGS) {
    const inst = getInstance(slug);
    const g = groupSlug.get(inst.group) ?? { b2b: slug, b2c: slug };
    if (inst.tier === "b2b") g.b2b = slug; else g.b2c = slug;
    groupSlug.set(inst.group, g);
  }

  // per tag: staying by instance slug + a vote for the tag's dominant group
  interface Agg { byInst: Map<BisonInstanceSlug, { staying: number; total: number }>; groupTotal: Map<BisonGroup, number> }
  const byTag = new Map<string, Agg>();
  for (const a of plan.clientAudit) {
    const slug = a.instance as BisonInstanceSlug;
    const inst = getInstance(slug);
    let agg = byTag.get(a.clientTag);
    if (!agg) { agg = { byInst: new Map(), groupTotal: new Map() }; byTag.set(a.clientTag, agg); }
    const cur = agg.byInst.get(slug) ?? { staying: 0, total: 0 };
    cur.staying += a.staying; cur.total += a.total;
    agg.byInst.set(slug, cur);
    agg.groupTotal.set(inst.group, (agg.groupTotal.get(inst.group) ?? 0) + a.total);
  }

  interface Side { instance: BisonInstanceSlug; short: number }
  const rows: { b2b: Side; b2c: Side }[] = [];
  const activeBuyTags = new Set<string>();
  for (const [tag, agg] of byTag) {
    const tier: ClientTier = tiers.get(tag) ?? "1";
    // dominant group = the one holding the most of this tag's domains
    let group: BisonGroup = 1; let best = -1;
    for (const [g, t] of agg.groupTotal) if (t > best) { best = t; group = g; }
    const slugs = groupSlug.get(group)!;
    const build = (slug: BisonInstanceSlug): Side => {
      const have = agg.byInst.get(slug)?.staying ?? 0;
      const liveCap = capFor(getInstance(slug).tier, tier);
      // Dormant side (no actively-sending campaign for this tag here) never
      // triggers buying — Nick 2026-08-11. Mirrors the shortfall route exactly.
      const active = activeKeys.has(`${tag.trim().toUpperCase()}:${slug}`);
      return { instance: slug, short: active ? Math.max(0, liveCap - have) : 0 };
    };
    rows.push({ b2b: build(slugs.b2b), b2c: build(slugs.b2c) });
    activeBuyTags.add(tag.trim().toUpperCase());
  }

  // Upcoming launches (Spencer 2026-08-31: start on the 1st → Group 2, on the
  // 15th → Group 1) — full launch stock per instance of the group, sized by
  // tier cap. Already-active tags are the maintenance math's job. Start dates
  // on neither day are listed unassigned, never guessed. Fail-open: a
  // forecast read failure must not blank the maintenance list.
  const upcomingBySlug = new Map<BisonInstanceSlug, { tag: string; startDate: string; need: number }[]>();
  const upcomingUnassigned: { tag: string; startDate: string }[] = [];
  try {
    const forecast = await getGoingLiveForecast({});
    const candidates = [...forecast.onNextFirst, ...forecast.onNextFifteenth, ...forecast.otherUpcoming]
      .filter((c) => c.source === "startDate" && !activeBuyTags.has(c.clientAbbr));
    // Pre-provisioned stock: an upcoming client may already hold tagged
    // domains (no campaigns yet, so invisible to the active math) — charge
    // only what's MISSING, or five Sep-1 launches get their 20 re-bought.
    const have = await getTaggedDomainCounts(candidates.map((c) => c.clientAbbr), ALL_INSTANCE_SLUGS);
    for (const c of candidates) {
      if (c.group === null) { upcomingUnassigned.push({ tag: c.clientAbbr, startDate: c.date }); continue; }
      const clientTier = tiers.get(c.clientAbbr) ?? "1";
      for (const slug of ALL_INSTANCE_SLUGS) {
        if (getInstance(slug).group !== c.group) continue;
        const need = Math.max(0, capFor(getInstance(slug).tier, clientTier) - (have.get(`${c.clientAbbr}:${slug}`) ?? 0));
        if (need === 0) continue;
        const list = upcomingBySlug.get(slug) ?? [];
        list.push({ tag: c.clientAbbr, startDate: c.date, need });
        upcomingBySlug.set(slug, list);
      }
    }
  } catch (e) {
    console.error("[buy-alert] upcoming forecast read failed (maintenance list unaffected):", e);
  }

  const byInstance: BuyInstanceLine[] = ALL_INSTANCE_SLUGS.map((slug) => {
    const tier = getInstance(slug).tier;
    const isB2b = tier === "b2b";
    let domains = 0, clientsShort = 0;
    for (const r of rows) {
      const s = isB2b ? r.b2b : r.b2c;
      if (s.instance !== slug || s.short <= 0) continue;
      domains += s.short; clientsShort += 1;
    }
    const upcoming = upcomingBySlug.get(slug) ?? [];
    const upcomingDomains = upcoming.reduce((s, u) => s + u.need, 0);
    domains += upcomingDomains;
    return {
      instance: slug, label: INSTANCE_SHORT_LABELS[slug], tier, clientsShort,
      domains, inboxes: domains * MAILBOXES_PER_DOMAIN,
      upcomingDomains, upcomingClients: upcoming.length,
    };
  });

  const totalDomains = byInstance.reduce((s, i) => s + i.domains, 0);
  const totalInboxes = totalDomains * MAILBOXES_PER_DOMAIN;
  const checkedAt = new Date().toISOString();
  const detector = useGroups ? "groups" as const : "guardrails" as const;
  const tierSource = tiers.size > 0 ? "client-tracker" as const : "default-tier-1" as const;
  const base = { checkedAt, detector, tierSource, totalDomains, totalInboxes, byInstance };

  if (opts.dryRun) return { ...base, alerted: false, slackReason: "dry run" };
  if (totalDomains === 0 && !opts.force) return { ...base, alerted: false };

  const mentions = mentionPrefix();
  const lines: string[] = [`*🛒 Weekly domain buy list — LeadSync*${mentions ? ` ${mentions}` : ""}`];
  if (totalDomains === 0) {
    lines.push("✅ Every client is at its live cap — nothing to buy this week.");
  } else {
    lines.push("Order these to bring every client up to its live cap, then add them to the matching instance:");
    for (const i of byInstance) {
      if (i.domains <= 0) continue;
      const upcomingNote = i.upcomingClients > 0
        ? ` (incl. *${i.upcomingDomains}* for ${i.upcomingClients} upcoming launch${i.upcomingClients === 1 ? "" : "es"})`
        : "";
      lines.push(
        `• *${i.label}* (${i.tier.toUpperCase()}): buy *${i.domains}* domain${i.domains === 1 ? "" : "s"} ` +
        `(~${i.inboxes.toLocaleString()} inboxes) · ${i.clientsShort} client${i.clientsShort === 1 ? "" : "s"} short${upcomingNote}`,
      );
    }
    lines.push(`*Total: ${totalDomains} domain${totalDomains === 1 ? "" : "s"} (~${totalInboxes.toLocaleString()} inboxes)*`);
  }
  if (upcomingUnassigned.length > 0) {
    lines.push(
      `⚠️ Start date is neither the 1st nor the 15th — no group assigned, not counted: ` +
      upcomingUnassigned.map((u) => `${u.tag} (${u.startDate})`).join(", "),
    );
  }
  lines.push(`_Tier-aware caps (col K) · active + upcoming (1st→G2, 15th→G1) · detector: ${detector} · observe-only, nothing was bought._`);

  const slack = await postSlackMessage(lines.join("\n"), channelId());
  return { ...base, alerted: slack.ok, slackReason: slack.reason };
}
