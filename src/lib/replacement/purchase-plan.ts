// Purchase calculator — "buy X more domains per instance". READ-ONLY. Reuses the
// replacement plan's client audit + reserve counts to answer: how many fresh
// domains does each instance need to buy so every active client can be topped up
// to its per-client cap (Spencer: 20 B2B / 5 B2C) AND we still keep a reserve
// buffer left over? Pulling reserve to fill client caps depletes reserve, so the
// buy target = (cap shortfall + reserve floor) − reserve on hand.
import { buildReplacementPlan } from "./plan";
import { getThresholdConfig } from "./threshold-groups-store";
import { getGoingLiveForecast, type GoingLiveClient } from "./going-live";
import { capFor, reserveBufferFor, getClientTiers } from "./client-tiers";
import { getTaggedDomainCounts } from "./upcoming-stock";
import { getStockCounts } from "./stock-counts";
import { getActiveAnticipated, groupForStartDate } from "./anticipated-clients";
import { getActiveCampaignKeys } from "./campaigns";
import type { BisonGroup, BisonInstanceSlug } from "@/lib/bison-instances";
import { ALL_INSTANCE_SLUGS, BISON_INSTANCES, getInstance } from "@/lib/bison-instances";

/** Reserve buffer per CLIENT TAG, by the client's own tier (Spencer 2026-08-04,
 *  restated 2026-09-24): 3 B2B / 2 B2C for tier 0.5 and 1, 6 B2B / 4 B2C for
 *  tier 2. See reserveBufferFor. The flat defaults below are only the fallback
 *  used when a tag has no tier at all. */
const BUFFER_PER_TAG_B2B = Math.max(0, Number(process.env.RESERVE_BUFFER_PER_TAG_B2B ?? 3));
const BUFFER_PER_TAG_B2C = Math.max(0, Number(process.env.RESERVE_BUFFER_PER_TAG_B2C ?? 2));

export interface ShortClient {
  clientTag: string;
  staying: number;   // healthy domains that remain (cap baseline)
  capMax: number;
  short: number;     // capMax − staying (>0)
}

export interface UpcomingClientNeed {
  clientTag: string;
  startDate: string;
  goLiveDate: string | null;
  need: number;              // full cap for this instance's tier × client tier
}

export interface InstancePurchase {
  instance: string;
  tier: string;
  clients: number;          // active clients in this instance
  capDeficit: number;       // Σ shortfall to bring every client to cap
  /** Σ full-cap stock for clients launching here soon (Spencer 2026-08-31:
   *  start on the 1st → Group 2, on the 15th → Group 1). */
  upcomingNeed: number;
  upcomingClients: UpcomingClientNeed[];
  /** Clients expected on an upcoming start date but not in the tracker yet,
   *  entered on the Replacement tab. Counted exactly as the Slack buy list
   *  counts them, so the two never disagree. */
  anticipatedClients: number;
  anticipatedNeed: number;
  reserveFloor: number;     // buffer we want to keep, at each client's own tier
  /** Usable reserve by the allocator's own definition (getStockCounts): real
   *  inboxes only, warmed, truly untagged. Same source as the Slack buy list
   *  so the dashboard and Slack can never disagree. */
  availableReserve: number;
  /** Provider orders placed but not yet visible in Bison — owned, not re-buyable. */
  inflight: number;
  /** In Bison with real inboxes but under 21 days old — bought, don't re-buy. */
  warming: number;
  toBuy: number;            // recommended purchase = max(0, capDeficit + upcoming + floor − available)
  shortClients: ShortClient[];
}

export interface PurchasePlanResult {
  generatedFor: string;
  bufferPerTag: { b2b: number; b2c: number };
  totalToBuy: number;
  byInstance: InstancePurchase[];
  /** Upcoming clients whose start date is neither the 1st nor the 15th — the
   *  group rule can't place them, so they're surfaced instead of guessed. */
  upcomingUnassigned: { clientTag: string; startDate: string }[];
}

export async function computePurchasePlan(): Promise<PurchasePlanResult> {
  // Same burnt detector as the Slack buy list: when the segmented threshold
  // groups are enabled THEY decide what is burnt, otherwise the flat
  // guardrails do. Running a different detector here gave a different
  // "staying" count and therefore a different shortfall (2026-09-24).
  const cfg = await getThresholdConfig();
  const plan = await buildReplacementPlan(
    cfg.enabled ? { burntSource: "groups", groupConfig: cfg, infoMigration: false } : { infoMigration: false },
  );

  // Upcoming launches (Spencer 2026-08-31): a client starting on the 1st needs
  // full launch stock in BOTH Group 2 instances, on the 15th in Group 1 —
  // sized by tier cap. Clients already active in the plan are skipped (their
  // shortfall is the active math's job); start dates that are neither the 1st
  // nor the 15th are surfaced unassigned rather than guessed. Fail-open: a
  // forecast/tier read failure must never blank the maintenance numbers.
  const activeTags = new Set(plan.clientAudit.map((a) => a.clientTag));
  const upcomingByInstance = new Map<string, UpcomingClientNeed[]>();
  const upcomingUnassigned: { clientTag: string; startDate: string }[] = [];
  let tiers = new Map<string, import("./client-tiers").ClientTier>();
  try {
    const [forecast, loadedTiers] = await Promise.all([getGoingLiveForecast({}), getClientTiers()]);
    tiers = loadedTiers;
    const all: GoingLiveClient[] = [...forecast.onNextFirst, ...forecast.onNextFifteenth, ...forecast.otherUpcoming]
      .filter((c) => c.source === "startDate" && !activeTags.has(c.clientAbbr));
    // Charge only what's MISSING: pre-provisioned upcoming clients already
    // hold tagged domains that the active math can't see (no campaigns yet).
    const have = await getTaggedDomainCounts(all.map((c) => c.clientAbbr), ALL_INSTANCE_SLUGS);
    for (const c of all) {
      if (c.group === null) {
        upcomingUnassigned.push({ clientTag: c.clientAbbr, startDate: c.date });
        continue;
      }
      const clientTier = tiers.get(c.clientAbbr) ?? "1"; // unknown → conservative low cap
      for (const inst of ALL_INSTANCE_SLUGS) {
        if (BISON_INSTANCES[inst].group !== c.group) continue;
        const need = Math.max(0, capFor(BISON_INSTANCES[inst].tier, clientTier) - (have.get(`${c.clientAbbr}:${inst}`) ?? 0));
        if (need === 0) continue;
        const list = upcomingByInstance.get(inst) ?? [];
        list.push({ clientTag: c.clientAbbr, startDate: c.date, goLiveDate: c.goLiveDate, need });
        upcomingByInstance.set(inst, list);
      }
    }
  } catch (e) {
    console.error("[purchase-plan] upcoming-clients read failed (maintenance numbers unaffected):", e);
  }

  // Anticipated clients (Spencer 2026-09-21): launches not in the tracker yet,
  // entered on this same tab. The Slack buy list has counted them since it was
  // built; this card did not, so the two disagreed by exactly their launch
  // stock (2026-09-24). Fail-open — a Redis hiccup must not blank the card.
  const anticipatedByInstance = new Map<string, { clients: number; need: number; buffer: number }>();
  try {
    for (const a of await getActiveAnticipated()) {
      const group = groupForStartDate(a.startDate);
      if (group === null) continue;
      for (const inst of ALL_INSTANCE_SLUGS) {
        if (BISON_INSTANCES[inst].group !== group) continue;
        const cur = anticipatedByInstance.get(inst) ?? { clients: 0, need: 0, buffer: 0 };
        cur.clients += a.clients;
        cur.need += a.clients * capFor(BISON_INSTANCES[inst].tier, a.tier);
        cur.buffer += a.clients * reserveBufferFor(BISON_INSTANCES[inst].tier, a.tier);
        anticipatedByInstance.set(inst, cur);
      }
    }
  } catch (e) {
    console.error("[purchase-plan] anticipated-clients read failed (ignored):", e);
  }

  // Shortfall, counted exactly as the Slack buy list counts it so the two can
  // never disagree (2026-09-24). Two gates the old per-instance sum missed:
  //   • a client is charged only on its DOMINANT group — the pair of instances
  //     holding most of its domains. Summing every instance a tag appears on
  //     billed the same client twice and read 189 short on FR against 47.
  //   • an instance with no actively-sending campaign for that tag never
  //     triggers buying (Nick 2026-08-11).
  const groupSlug = new Map<BisonGroup, { b2b: BisonInstanceSlug; b2c: BisonInstanceSlug }>();
  for (const slug of ALL_INSTANCE_SLUGS) {
    const i = getInstance(slug);
    const g = groupSlug.get(i.group) ?? { b2b: slug, b2c: slug };
    if (i.tier === "b2b") g.b2b = slug; else g.b2c = slug;
    groupSlug.set(i.group, g);
  }
  const activeKeys = await getActiveCampaignKeys().catch(() => new Set<string>());
  interface Agg { byInst: Map<string, { staying: number; total: number; capMax: number }>; groupTotal: Map<BisonGroup, number> }
  const byTag = new Map<string, Agg>();
  for (const a of plan.clientAudit) {
    const slug = a.instance as BisonInstanceSlug;
    const g = getInstance(slug).group;
    let agg = byTag.get(a.clientTag);
    if (!agg) { agg = { byInst: new Map(), groupTotal: new Map() }; byTag.set(a.clientTag, agg); }
    const cur = agg.byInst.get(slug) ?? { staying: 0, total: 0, capMax: a.capMax };
    cur.staying += a.staying; cur.total += a.total; cur.capMax = a.capMax;
    agg.byInst.set(slug, cur);
    agg.groupTotal.set(g, (agg.groupTotal.get(g) ?? 0) + a.total);
  }
  // Same stock counters the Slack buy list uses — and the same tag set fed
  // into them. A domain carrying any known client tag is not reserve, so
  // passing a narrower set than the buy list made stock read higher here.
  const stock = await getStockCounts(new Set([...byTag.keys()].map((t) => t.toUpperCase())));

  const shortByInstance = new Map<string, ShortClient[]>();
  const clientsByInstance = new Map<string, number>();
  for (const [tag, agg] of byTag) {
    const clientTier = tiers.get(tag.trim().toUpperCase()) ?? "1";
    let group: BisonGroup = 1; let best = -1;
    for (const [g, t] of agg.groupTotal) if (t > best) { best = t; group = g; }
    const slugs = groupSlug.get(group)!;
    for (const slug of [slugs.b2b, slugs.b2c]) {
      clientsByInstance.set(slug, (clientsByInstance.get(slug) ?? 0) + 1);
      if (!activeKeys.has(`${tag.trim().toUpperCase()}:${slug}`)) continue;
      const staying = agg.byInst.get(slug)?.staying ?? 0;
      const capMax = capFor(getInstance(slug).tier, clientTier);
      const short = Math.max(0, capMax - staying);
      if (short <= 0) continue;
      const list = shortByInstance.get(slug) ?? [];
      list.push({ clientTag: tag, staying, capMax, short });
      shortByInstance.set(slug, list);
    }
  }

  const byInstance: InstancePurchase[] = ALL_INSTANCE_SLUGS.map((inst) => {
    const shortClients = (shortByInstance.get(inst) ?? []).sort((a, b) => b.short - a.short);
    let activeClientCount = 0;
    for (const tag of byTag.keys()) {
      if (activeKeys.has(`${tag.trim().toUpperCase()}:${inst}`)) activeClientCount++;
    }

    const capDeficit = shortClients.reduce((s, c) => s + c.short, 0);
    const upcomingClients = (upcomingByInstance.get(inst) ?? []).sort((a, b) => a.startDate.localeCompare(b.startDate) || a.clientTag.localeCompare(b.clientTag));
    const upcomingNeed = upcomingClients.reduce((s, c) => s + c.need, 0);
    const availableReserve = stock.usableReserve[inst] ?? 0;
    const inflight = stock.inflight[inst] ?? 0;
    // Warming stock is already bought and must not be bought twice — the Slack
    // buy list has credited it since 2026-09-16; this card did not.
    const warming = stock.warming[inst] ?? 0;
    const tier = getInstance(inst).tier;
    const anticipated = anticipatedByInstance.get(inst) ?? { clients: 0, need: 0, buffer: 0 };

    // floor = each client's OWN tier buffer, across every client this instance
    // will carry: active, launching, and anticipated.
    const fallback = tier === "b2b" ? BUFFER_PER_TAG_B2B : BUFFER_PER_TAG_B2C;
    // Buffer is charged for clients ACTIVELY SENDING on this instance, plus
    // launching and anticipated ones — the same set the Slack buy list uses.
    // Charging every client on the dominant group instead billed buffer on
    // dormant sides and read 88 on CO against 12.
    let reserveFloor = anticipated.buffer;
    for (const tag of byTag.keys()) {
      if (!activeKeys.has(`${tag.trim().toUpperCase()}:${inst}`)) continue;
      const t = tiers.get(tag.trim().toUpperCase());
      reserveFloor += t ? reserveBufferFor(tier, t) : fallback;
    }
    for (const u of upcomingClients) {
      const t = tiers.get(u.clientTag.trim().toUpperCase());
      reserveFloor += t ? reserveBufferFor(tier, t) : fallback;
    }

    const toBuy = Math.max(0, capDeficit + upcomingNeed + anticipated.need + reserveFloor - availableReserve - inflight - warming);

    return {
      instance: inst,
      tier,
      clients: activeClientCount,
      capDeficit,
      upcomingNeed,
      upcomingClients,
      anticipatedClients: anticipated.clients,
      anticipatedNeed: anticipated.need,
      reserveFloor,
      availableReserve,
      inflight,
      warming,
      toBuy,
      shortClients,
    };
  });

  const totalToBuy = byInstance.reduce((s, i) => s + i.toBuy, 0);
  return {
    generatedFor: plan.generatedFor,
    bufferPerTag: { b2b: BUFFER_PER_TAG_B2B, b2c: BUFFER_PER_TAG_B2C },
    totalToBuy,
    byInstance,
    upcomingUnassigned,
  };
}
