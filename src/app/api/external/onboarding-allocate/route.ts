import { NextResponse } from "next/server";
import { computeTrueUp } from "@/lib/replacement/true-up";
import { capFor, getClientTiers, type ClientTier } from "@/lib/replacement/client-tiers";
import { instancesInGroup, parseGroup } from "@/lib/bison-instances";
import { getGroupForClientTag } from "@/lib/client-tag-allocations";
import { getSupabaseAdmin } from "@/lib/supabase";

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
// Two things are stricter here than in the true-up, because this plan is acted
// on for a client nobody has seen run yet:
//   • the client's own domain count is read strictly — a failed read stops the
//     plan (read as "none yet", it would hand a full tier to a client that
//     already holds one);
//   • the true-up calls a domain reserve when none of its tags is a client it
//     KNOWS (one with a website or campaigns). A domain pre-tagged for a client
//     it doesn't know yet would slip through, so any candidate carrying a
//     Client Tracker tag is set aside.
//
// Body:  { clientTag, group: 1 | 2, tier?: "0.5" | "1" | "2", dryRun: true }
//        tier defaults to the Client Tracker's, else "1" (same default as
//        normalizeTier — the low cap, so a missing tier never over-allocates).
// 200:   { dryRun, clientTag, group, tier, tierSource, generatedFor,
//          allocationGroup, groupMismatch,
//          instances: [{ instance, label, side, cap, alreadyTagged, need,
//                        reserveAvailable, setAside, picking, short, note }] }
//        allocationGroup = the group the allocation sheet has this tag in
//        (null if it isn't there yet); groupMismatch = it differs from `group`.

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
    const supabase = getSupabaseAdmin();
    // The client's own domains, per instance. Tag names are matched as the
    // client tag is normally written (capitals) and in lower case.
    const own = await supabase
      .from("deliverability_domains")
      .select("instance")
      .in("instance", instances.map((i) => i.slug))
      .overlaps("tags", [...new Set([clientTag, clientTag.toLowerCase()])]);
    if (own.error) throw new Error(`could not read ${clientTag}'s current domains: ${own.error.message}`);
    const tagged = new Map<string, number>();
    for (const r of (own.data || []) as { instance: string }[]) tagged.set(r.instance, (tagged.get(r.instance) || 0) + 1);
    const allocationGroup = await getGroupForClientTag(clientTag).catch(() => null);
    const trueUp = await computeTrueUp();
    const trackerTier = tiers.get(clientTag) ?? null;
    const tier: ClientTier = (askedTier as ClientTier | null) ?? trackerTier ?? "1";
    const tierSource = askedTier ? "request" : trackerTier ? "client tracker" : "default";

    const plan = [];
    for (const inst of instances) {
      const cap = capFor(inst.tier, tier);
      const alreadyTagged = tagged.get(inst.slug) ?? 0;
      const need = Math.max(0, cap - alreadyTagged);
      // New launches take Outlook stock — the tiers are sold as Outlook domains.
      const pool = trueUp.reserveLeft[`${inst.slug}:outlook`] ?? [];
      // Look a little past what is needed, so set-aside domains can be replaced.
      const candidates = pool.slice(0, need + 40);
      let spoken = new Set<string>();
      if (need > 0 && candidates.length > 0) {
        const tags = await supabase
          .from("deliverability_domains")
          .select("domain, tags")
          .eq("instance", inst.slug)
          .in("domain", candidates);
        if (tags.error) throw new Error(`could not read the candidates' tags on ${inst.slug}: ${tags.error.message}`);
        spoken = new Set(
          ((tags.data || []) as { domain: string; tags: string[] | null }[])
            .filter((d) => (d.tags || []).some((t) => tiers.has(String(t).trim().toUpperCase())))
            .map((d) => d.domain),
        );
      }
      const picking = candidates.filter((d) => !spoken.has(d)).slice(0, need);
      // What the true-up itself says about this tag here, when it has a view.
      const row = trueUp.rows.find((r) => r.clientTag === clientTag && r.instance === inst.slug);
      const skip = trueUp.skipped.find((s) => s.clientTag === clientTag && s.instance === inst.slug);
      plan.push({
        instance: inst.slug,
        label: inst.label,
        side: inst.tier,
        cap,
        alreadyTagged,
        need,
        reserveAvailable: pool.length - spoken.size,
        setAside: spoken.size,
        picking,
        short: need - picking.length,
        note: skip?.reason ?? (row?.blockers.length ? row.blockers.join(", ") : null),
      });
    }

    return NextResponse.json({
      dryRun: true,
      clientTag,
      group,
      tier,
      tierSource,
      generatedFor: trueUp.generatedFor,
      allocationGroup,
      groupMismatch: allocationGroup !== null && allocationGroup !== group,
      instances: plan,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
