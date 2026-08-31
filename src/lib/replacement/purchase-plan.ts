// Purchase calculator — "buy X more domains per instance". READ-ONLY. Reuses the
// replacement plan's client audit + reserve counts to answer: how many fresh
// domains does each instance need to buy so every active client can be topped up
// to its per-client cap (Spencer: 20 B2B / 5 B2C) AND we still keep a reserve
// buffer left over? Pulling reserve to fill client caps depletes reserve, so the
// buy target = (cap shortfall + reserve floor) − reserve on hand.
import { buildReplacementPlan } from "./plan";
import { getGoingLiveForecast, type GoingLiveClient } from "./going-live";
import { capFor, getClientTiers } from "./client-tiers";
import { getTaggedDomainCounts } from "./upcoming-stock";
import { ALL_INSTANCE_SLUGS, BISON_INSTANCES, getInstance } from "@/lib/bison-instances";

/** Reserve buffer per CLIENT TAG (Spencer 2026-07-29): 3 on B2B instances,
 *  2 on B2C — an instance's floor scales with how many clients live on it. */
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
  reserveFloor: number;     // buffer we want to keep
  availableReserve: number; // current pull-able (outlook + google) reserve
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
  const plan = await buildReplacementPlan({ infoMigration: false });

  // Upcoming launches (Spencer 2026-08-31): a client starting on the 1st needs
  // full launch stock in BOTH Group 2 instances, on the 15th in Group 1 —
  // sized by tier cap. Clients already active in the plan are skipped (their
  // shortfall is the active math's job); start dates that are neither the 1st
  // nor the 15th are surfaced unassigned rather than guessed. Fail-open: a
  // forecast/tier read failure must never blank the maintenance numbers.
  const activeTags = new Set(plan.clientAudit.map((a) => a.clientTag));
  const upcomingByInstance = new Map<string, UpcomingClientNeed[]>();
  const upcomingUnassigned: { clientTag: string; startDate: string }[] = [];
  try {
    const [forecast, tiers] = await Promise.all([getGoingLiveForecast({}), getClientTiers()]);
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

  const byInstance: InstancePurchase[] = ALL_INSTANCE_SLUGS.map((inst) => {
    const rows = plan.clientAudit.filter((a) => a.instance === inst);
    const shortClients: ShortClient[] = rows
      .map((a) => ({ clientTag: a.clientTag, staying: a.staying, capMax: a.capMax, short: Math.max(0, a.capMax - a.staying) }))
      .filter((c) => c.short > 0)
      .sort((a, b) => b.short - a.short);

    const capDeficit = shortClients.reduce((s, c) => s + c.short, 0);
    const upcomingClients = (upcomingByInstance.get(inst) ?? []).sort((a, b) => a.startDate.localeCompare(b.startDate) || a.clientTag.localeCompare(b.clientTag));
    const upcomingNeed = upcomingClients.reduce((s, c) => s + c.need, 0);
    const r = plan.reserveReadyByInstance[inst];
    const availableReserve = (r?.outlook ?? 0) + (r?.google ?? 0);
    const tier = getInstance(inst).tier;
    // floor = per-tag buffer × every client this instance will carry (active + launching)
    const reserveFloor = (tier === "b2b" ? BUFFER_PER_TAG_B2B : BUFFER_PER_TAG_B2C) * (rows.length + upcomingClients.length);
    const toBuy = Math.max(0, capDeficit + upcomingNeed + reserveFloor - availableReserve);

    return {
      instance: inst,
      tier,
      clients: rows.length,
      capDeficit,
      upcomingNeed,
      upcomingClients,
      reserveFloor,
      availableReserve,
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
