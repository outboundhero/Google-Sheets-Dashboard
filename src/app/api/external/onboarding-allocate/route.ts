import { NextResponse } from "next/server";
import { computeTrueUp } from "@/lib/replacement/true-up";
import { capFor, getClientTiers, type ClientTier } from "@/lib/replacement/client-tiers";
import { getTaggedDomainCounts } from "@/lib/replacement/upcoming-stock";
import { instancesInGroup, parseGroup } from "@/lib/bison-instances";

// POST /api/external/onboarding-allocate   (Bearer EXTERNAL_API_TOKEN, middleware-exempt)
//
// Reply Router's onboarding checklist ("Attach client tags / redirects / add to
// campaigns") asks which reserve domains a brand-new client would be given.
// The true-up fill deliberately leaves a client that is not sending yet alone
// (initial domains are manual until the onboarding automation — Nick
// 2026-09-22); this is the read side of that automation.
//
// READ-ONLY. Only { dryRun: true } is accepted: it reports the plan and stops.
// Nothing here tags, redirects, attaches or emails.
//
// Same stock rules as the true-up, by construction: candidates come from
// computeTrueUp().reserveLeft — untagged, at least 21 days old, not Burnt, not
// blacklisted — i.e. what is still unspent AFTER every live client's fill has
// earmarked its share, so a launch never claims a domain the true-up is about
// to hand to someone else. Caps are the tier caps (client-tiers.ts).
//
// Body:  { clientTag, group: 1 | 2, tier?: "0.5" | "1" | "2", dryRun: true }
//        tier defaults to the Client Tracker's, else "1" (same default as
//        normalizeTier — the low cap, so a missing tier never over-allocates).
// 200:   { dryRun, clientTag, group, tier, tierSource, generatedFor,
//          instances: [{ instance, label, side, cap, alreadyTagged, need,
//                        reserveAvailable, picking, short, note }] }

const EXTERNAL_API_TOKEN = process.env.EXTERNAL_API_TOKEN || "outboundhero2024";

export const maxDuration = 120;

const TIERS: readonly ClientTier[] = ["0.5", "1", "2"];

interface Body {
  clientTag?: string;
  group?: unknown;
  tier?: unknown;
  dryRun?: boolean;
}

export async function POST(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${EXTERNAL_API_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await request.json().catch(() => ({}))) as Body;
    if (body.dryRun !== true) {
      return NextResponse.json({ error: "only { dryRun: true } is supported — this route does not allocate" }, { status: 400 });
    }
    const clientTag = (body.clientTag || "").trim().toUpperCase();
    const group = parseGroup(body.group);
    if (!clientTag || !group) {
      return NextResponse.json({ error: "clientTag and group (1 or 2) are required" }, { status: 400 });
    }
    const askedTier = body.tier == null || body.tier === "" ? null : String(body.tier).trim();
    if (askedTier !== null && !TIERS.includes(askedTier as ClientTier)) {
      return NextResponse.json({ error: 'tier must be "0.5", "1" or "2"' }, { status: 400 });
    }

    const instances = instancesInGroup(group);
    // One read at a time on purpose: the true-up pages every domain row, and
    // stacking the other reads on top of it is what tips a busy database into
    // a statement timeout.
    const tiers = await getClientTiers();
    const tagged = await getTaggedDomainCounts([clientTag], instances.map((i) => i.slug));
    const trueUp = await computeTrueUp();
    const trackerTier = tiers.get(clientTag) ?? null;
    const tier: ClientTier = (askedTier as ClientTier | null) ?? trackerTier ?? "1";
    const tierSource = askedTier ? "request" : trackerTier ? "client tracker" : "default";

    return NextResponse.json({
      dryRun: true,
      clientTag,
      group,
      tier,
      tierSource,
      generatedFor: trueUp.generatedFor,
      instances: instances.map((inst) => {
        const cap = capFor(inst.tier, tier);
        const alreadyTagged = tagged.get(`${clientTag}:${inst.slug}`) ?? 0;
        const need = Math.max(0, cap - alreadyTagged);
        // New launches take Outlook stock — the tiers are sold as Outlook domains.
        const pool = trueUp.reserveLeft[`${inst.slug}:outlook`] ?? [];
        const picking = pool.slice(0, need);
        // What the true-up itself says about this tag here, when it has a view.
        const row = trueUp.rows.find((r) => r.clientTag === clientTag && r.instance === inst.slug);
        const skip = trueUp.skipped.find((s) => s.clientTag === clientTag && s.instance === inst.slug);
        return {
          instance: inst.slug,
          label: inst.label,
          side: inst.tier,
          cap,
          alreadyTagged,
          need,
          reserveAvailable: pool.length,
          picking,
          short: need - picking.length,
          note: skip?.reason ?? (row?.blockers.length ? row.blockers.join(", ") : null),
        };
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
