import { NextResponse } from "next/server";
import { buildReplacementPlan } from "@/lib/replacement/plan";
import { getThresholdConfig } from "@/lib/replacement/threshold-groups-store";
import { getActiveCampaignKeys } from "@/lib/replacement/campaigns";
import { capFor, totalTargetFor, getClientTiers, type ClientTier } from "@/lib/replacement/client-tiers";
import {
  ALL_INSTANCE_SLUGS, getInstance, INSTANCE_SHORT_LABELS,
  type BisonInstanceSlug, type BisonGroup,
} from "@/lib/bison-instances";

export const maxDuration = 60;

// GET /api/replacement/shortfall — OBSERVE-ONLY. Tier-aware "how many domains are
// we SHORT per b2b / b2c instance, per client tag" (Spencer 2026-08-04). Method:
// take the SAME burnt detection the group plan uses (threshold groups if enabled,
// else the flat guardrails), count the NON-FLAGGED domains that remain per
// (tag, instance) — plan.clientAudit.staying — then compare to the tier-based live
// cap (20/40 b2b, 5/10 b2c). short = cap − staying. Buys/executes nothing.

interface SideShort {
  instance: BisonInstanceSlug;
  label: string;
  have: number;      // non-flagged domains that stay for this tag on this instance
  liveCap: number;   // 20/40 (b2b) | 5/10 (b2c) by client tier
  totalTarget: number; // live cap + reserve buffer
  short: number;     // max(0, liveCap − have)
  excess: number;    // max(0, have − liveCap)
  /** No actively-sending campaign for this tag on this instance → short forced
   *  to 0 (Nick 2026-08-11: dormant campaigns must not trigger purchases). */
  inactive?: boolean;
}
interface TagRow {
  clientTag: string;
  tier: ClientTier;
  group: BisonGroup;
  b2b: SideShort;
  b2c: SideShort;
}

export async function GET() {
  try {
    const cfg = await getThresholdConfig();
    const useGroups = cfg.enabled;
    const [plan, tiers, activeKeys] = await Promise.all([
      buildReplacementPlan(useGroups ? { burntSource: "groups", groupConfig: cfg, infoMigration: false } : { infoMigration: false }),
      getClientTiers(),
      getActiveCampaignKeys(),
    ]);

    // group → its b2b + b2c instance slug
    const groupSlug = new Map<BisonGroup, { b2b: BisonInstanceSlug; b2c: BisonInstanceSlug }>();
    for (const slug of ALL_INSTANCE_SLUGS) {
      const inst = getInstance(slug);
      const g = groupSlug.get(inst.group) ?? { b2b: slug, b2c: slug };
      if (inst.tier === "b2b") g.b2b = slug; else g.b2c = slug;
      groupSlug.set(inst.group, g);
    }

    // per tag: staying/total by instance slug, and vote for the tag's dominant group
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

    const side = (slug: BisonInstanceSlug, tier: ClientTier): SideShort => {
      const it = getInstance(slug).tier;
      const have = 0; // filled by caller
      const liveCap = capFor(it, tier);
      return { instance: slug, label: INSTANCE_SHORT_LABELS[slug], have, liveCap, totalTarget: totalTargetFor(it, tier), short: liveCap, excess: 0 };
    };

    const rows: TagRow[] = [];
    for (const [tag, agg] of byTag) {
      const tier = tiers.get(tag) ?? "1";
      // dominant group = the one holding the most of this tag's domains
      let group: BisonGroup = 1; let best = -1;
      for (const [g, t] of agg.groupTotal) if (t > best) { best = t; group = g; }
      const slugs = groupSlug.get(group)!;

      const build = (slug: BisonInstanceSlug): SideShort => {
        const s = side(slug, tier);
        s.have = agg.byInst.get(slug)?.staying ?? 0;
        s.short = Math.max(0, s.liveCap - s.have);
        s.excess = Math.max(0, s.have - s.liveCap);
        // Dormant side: tag has no actively-sending campaign on this instance
        // → never counts toward buying (Nick 2026-08-11).
        if (!activeKeys.has(`${tag.trim().toUpperCase()}:${slug}`)) {
          s.short = 0;
          s.inactive = true;
        }
        return s;
      };
      rows.push({ clientTag: tag, tier, group, b2b: build(slugs.b2b), b2c: build(slugs.b2c) });
    }
    rows.sort((a, b) => (b.b2b.short + b.b2c.short) - (a.b2b.short + a.b2c.short) || a.clientTag.localeCompare(b.clientTag));

    // per-instance roll-up: "add N to this instance" across all tags
    const byInstance = ALL_INSTANCE_SLUGS.map((slug) => {
      const isB2b = getInstance(slug).tier === "b2b";
      let short = 0, excess = 0, clients = 0;
      for (const r of rows) {
        const s = isB2b ? r.b2b : r.b2c;
        if (s.instance !== slug) continue;
        short += s.short; excess += s.excess; clients += 1;
      }
      return { instance: slug, label: INSTANCE_SHORT_LABELS[slug], tier: getInstance(slug).tier, clients, short, excess };
    });

    return NextResponse.json({
      generatedFor: plan.generatedFor,
      burntSource: useGroups ? "groups" : "guardrails",
      tierSource: tiers.size > 0 ? "client-tracker" : "default-tier-1",
      totalShort: byInstance.reduce((s, i) => s + i.short, 0),
      byInstance,
      rows,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
