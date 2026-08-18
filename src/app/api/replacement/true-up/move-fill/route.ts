import { NextResponse } from "next/server";
import { computeTrueUp } from "@/lib/replacement/true-up";
import { internalFetch } from "@/lib/replacement/internal-fetch";
import { logEvents } from "@/lib/replacement/store";
import { ALL_INSTANCE_SLUGS, type BisonInstanceSlug } from "@/lib/bison-instances";
import { inboxingConnectionFor, DEFAULT_INBOXING_ACCOUNT } from "@/lib/inboxing-accounts";
import { getSupabaseAdmin } from "@/lib/supabase";

export const maxDuration = 300;

// POST /api/replacement/true-up/move-fill — covers a starving instance from a
// sibling that has spare reserve.
//
// Nick asked for this three times (2026-08-17, 12:10 / 12:12 / 12:16):
//   "if B2B 2 has domains to move over then move those domains over to the
//    instance that needs domains then the system would tag and change redirect
//    and add to campaigns"
//
// The gap it closes: the fill only ever draws from the reserve of the SAME
// instance, so B2B #1 can be ~149 short while B2B #2 sits on spare stock and
// nothing connects the two.
//
// Flow per batch:
//   1. read the true-up → who is short, and which instances have reserve left
//   2. pick donor domains from a same-TIER instance (B2B→B2B, B2C→B2C)
//   3. POST /api/deliverability/move-domains (Inboxing Platform Upload)
//   4. the caller re-runs the FILL once the senders land on the target
//
// Deliberately TWO steps, not one. The move is asynchronous — Inboxing queues
// an upload job and senders appear on the target minutes later. Tagging and
// attaching before they exist would silently no-op, which is exactly the class
// of bug that made the JPWC attach look complete when it wasn't. So this route
// moves and reports; the fill (which already tags, sets the redirect, attaches
// campaigns and whitelists) runs after, against domains that are really there.
//
// Only Inboxing-provisioned domains can move — move-domains rides Inboxing's
// upload API because Bison exposes neither mailbox passwords nor OAuth
// creation. Anything else is reported as unmovable rather than half-attempted.
//
// Body:
//   { dryRun: true }                  plan only (default when omitted)
//   { targetInstance }                limit to one starving instance
//   { maxDomains }                    cap the batch (default 20)

// Sized to the 300s function limit: submit costs ~3 Inboxing calls per domain
// (resolve, tag sync, upload), so 40 keeps a click comfortably inside it. 100
// in one request is what blew the limit on the first live batch — the batch
// only decides how many uploads get QUEUED per click; landing is async and
// the next click finalizes whatever has arrived.
const DEFAULT_MAX_DOMAINS = 40;

interface Body {
  targetInstance?: string;
  dryRun?: boolean;
  maxDomains?: number;
}

/** B2B instances pair with B2B, B2C with B2C — a B2C domain is no use to a
 *  B2B client's cap and vice versa. */
const TIER_OF: Record<string, "b2b" | "b2c"> = {
  outboundhero: "b2b",
  facilityreach: "b2b",
  cleaningoutbound: "b2c",
  outboundclean: "b2c",
};

/** Same test move-domains applies before it will touch a domain. */
const hasInboxingTag = (tags: string[] | null) =>
  (tags || []).some((t) => (t || "").trim().toLowerCase().startsWith("inboxing"));

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Body;
    const dryRun = body.dryRun !== false;
    const maxDomains = Math.max(1, Math.min(100, body.maxDomains ?? DEFAULT_MAX_DOMAINS));

    const trueUp = await computeTrueUp();

    // How short each instance is, once its own reserve has been spent.
    const shortByInstance = new Map<string, number>();
    for (const slug of ALL_INSTANCE_SLUGS) {
      const b = trueUp.byInstance[slug];
      if (b && b.fillShort > 0) shortByInstance.set(slug, b.fillShort);
    }

    // Spare stock per instance, flattened across providers.
    const spareByInstance = new Map<string, { domain: string; provider: string }[]>();
    for (const [key, domains] of Object.entries(trueUp.reserveLeft)) {
      const sep = key.lastIndexOf(":");
      const inst = key.slice(0, sep);
      const provider = key.slice(sep + 1);
      const list = spareByInstance.get(inst) ?? [];
      for (const d of domains) list.push({ domain: d, provider });
      spareByInstance.set(inst, list);
    }

    // Drop candidates move-domains would refuse anyway: non-Inboxing domains
    // (Bison exposes no passwords, so only Inboxing's upload API can move
    // them) and domains already present on more than one instance (mid-move).
    // Without this the plan re-picks the same dead candidates every run — the
    // first live batch burned 11 of its 20 slots on .info domains, and each
    // completed move adds another dead slot, so repeat runs would stall
    // before the shortfall is covered.
    const supabase = getSupabaseAdmin();
    const allCandidates = [...new Set([...spareByInstance.values()].flat().map((c) => c.domain))];
    const rowsByDomain = new Map<
      string,
      { instance: string; tags: string[] | null; inbox_count: number }[]
    >();
    for (let i = 0; i < allCandidates.length; i += 200) {
      const chunk = allCandidates.slice(i, i + 200);
      const { data, error } = await supabase
        .from("deliverability_domains")
        .select("instance, domain, tags, inbox_count")
        .in("domain", chunk);
      if (error) throw new Error(`candidate lookup failed: ${error.message}`);
      for (const r of data || []) {
        const list = rowsByDomain.get(r.domain) ?? [];
        list.push({
          instance: r.instance,
          tags: r.tags as string[] | null,
          inbox_count: (r.inbox_count as number | null) ?? 0,
        });
        rowsByDomain.set(r.domain, list);
      }
    }
    // Mid-move domains: reserve on the donor AND a second, still-empty row on
    // another instance — an upload was queued but never finalized (a previous
    // run timed out, or the senders hadn't landed yet). The next execute polls
    // these to completion instead of stranding them; a legit long-standing
    // duplicate has inboxes on both sides and is left alone.
    const midMove: { domain: string; source: string; target: string; expected: number }[] = [];
    let unmovable = 0;
    for (const [inst, list] of spareByInstance) {
      const movable = list.filter((item) => {
        const rows = rowsByDomain.get(item.domain) ?? [];
        if (rows.length === 2) {
          const here = rows.find((r) => r.instance === inst);
          const there = rows.find((r) => r.instance !== inst);
          if (here && there && there.inbox_count === 0 && hasInboxingTag(here.tags)) {
            midMove.push({
              domain: item.domain,
              source: inst,
              target: there.instance,
              expected: here.inbox_count > 0 ? here.inbox_count : 1,
            });
          }
          return false;
        }
        if (rows.length !== 1) return false; // on 3+ instances (or unknown) — move-domains skips these
        return rows[0].instance === inst && hasInboxingTag(rows[0].tags);
      });
      unmovable += list.length - movable.length;
      spareByInstance.set(inst, movable);
    }

    let targets = [...shortByInstance.entries()].sort((a, b) => b[1] - a[1]);
    if (body.targetInstance) {
      targets = targets.filter(([slug]) => slug === body.targetInstance);
      if (targets.length === 0) {
        return NextResponse.json(
          { error: `${body.targetInstance} is not short on domains` },
          { status: 400 },
        );
      }
    }

    if (targets.length === 0) {
      return NextResponse.json({
        dryRun,
        plan: [],
        note: "No instance is short once its own reserve is counted.",
      });
    }

    // Build the plan: for each starving instance, draw from same-tier donors.
    const claimed = new Set<string>();
    const plan: {
      targetInstance: string;
      short: number;
      moving: { domain: string; fromInstance: string; provider: string }[];
      stillShort: number;
      donorsExhausted: boolean;
    }[] = [];

    for (const [target, short] of targets) {
      const tier = TIER_OF[target];
      const moving: { domain: string; fromInstance: string; provider: string }[] = [];

      const donors = [...spareByInstance.entries()]
        .filter(([slug]) => slug !== target && TIER_OF[slug] === tier)
        // deepest reserve first
        .sort((a, b) => b[1].length - a[1].length);

      for (const [donor, list] of donors) {
        for (const item of list) {
          if (moving.length >= Math.min(short, maxDomains)) break;
          const k = `${donor}:${item.domain}`;
          if (claimed.has(k)) continue;
          claimed.add(k);
          moving.push({ domain: item.domain, fromInstance: donor, provider: item.provider });
        }
        if (moving.length >= Math.min(short, maxDomains)) break;
      }

      plan.push({
        targetInstance: target,
        short,
        moving,
        stillShort: Math.max(0, short - moving.length),
        donorsExhausted: moving.length < Math.min(short, maxDomains),
      });
    }

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        plan,
        totalMoving: plan.reduce((s, p) => s + p.moving.length, 0),
        unmovable,
        finalizePending: midMove.length,
        note:
          "Move only. After the senders land on the target, run the fill to tag, set the redirect and attach campaigns." +
          (midMove.length > 0
            ? ` ${midMove.length} earlier upload${midMove.length === 1 ? "" : "s"} will be checked and finalized first.`
            : "") +
          (unmovable > midMove.length
            ? ` ${unmovable - midMove.length} reserve domain${unmovable - midMove.length === 1 ? "" : "s"} can't move (not Inboxing-provisioned).`
            : ""),
      });
    }

    // Execute — submit + poll, never the legacy combined mode. Combined waits
    // in-request for Inboxing uploads to land, which blew the 300s function
    // limit on the first 100-domain batch and lost the in-flight set. Submit
    // returns as soon as the uploads are queued; the arrival check happens on
    // the NEXT click via the poll pass below, which re-discovers in-flight
    // domains from the DB instead of trusting anyone to have kept a list.
    const results: {
      targetInstance: string;
      fromInstance: string;
      requested: number;
      moved: string[];
      uploading: string[];
      skipped: { domain: string; reason: string }[];
      error?: string;
    }[] = [];

    // Pass 1 — finalize earlier uploads that have landed (recovery included).
    const pollPairs = new Map<string, typeof midMove>();
    for (const m of midMove) {
      const k = `${m.source}→${m.target}`;
      pollPairs.set(k, [...(pollPairs.get(k) ?? []), m]);
    }
    for (const group of pollPairs.values()) {
      const { source, target } = group[0];
      try {
        const res = await internalFetch("/api/deliverability/move-domains", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "poll",
            targetInstance: target,
            inflight: group.map((m) => ({
              domain: m.domain,
              sourceInstance: m.source,
              expected: m.expected,
            })),
          }),
        });
        const json = await res.json().catch(() => ({}));
        const rows = (json.results || []) as { domain: string; status: string; error?: string }[];
        results.push({
          targetInstance: target,
          fromInstance: source,
          requested: group.length,
          moved: rows.filter((r) => r.status === "done").map((r) => r.domain),
          uploading: rows.filter((r) => r.status === "uploading").map((r) => r.domain),
          skipped: rows
            .filter((r) => r.status === "skipped" || r.status === "failed")
            .map((r) => ({ domain: r.domain, reason: r.error || r.status })),
          ...(!res.ok || json?.error ? { error: json?.error || `HTTP ${res.status}` } : {}),
        });
      } catch (e) {
        results.push({
          targetInstance: target,
          fromInstance: source,
          requested: group.length,
          moved: [],
          uploading: [],
          skipped: [],
          error: e instanceof Error ? e.message : "finalize poll failed",
        });
      }
    }

    // Pass 2 — queue this batch's uploads.
    for (const p of plan) {
      const byDonor = new Map<string, string[]>();
      for (const m of p.moving) {
        const list = byDonor.get(m.fromInstance) ?? [];
        list.push(m.domain);
        byDonor.set(m.fromInstance, list);
      }

      for (const [donor, domains] of byDonor) {
        await logEvents([
          {
            instance: p.targetInstance as BisonInstanceSlug,
            clientTag: null,
            eventType: "proposed",
            detail: `cross-instance move: pulling ${domains.length} from ${donor} to cover ${p.short} short`,
          },
        ]).catch(() => {});

        try {
          // move-domains requires a non-empty platformConnectionId even though
          // it re-resolves the real one per domain from that domain's Inboxing
          // account. Pass the target's default for the primary account.
          const connectionId = inboxingConnectionFor(
            p.targetInstance as BisonInstanceSlug,
            DEFAULT_INBOXING_ACCOUNT,
          );
          if (!connectionId) {
            results.push({
              targetInstance: p.targetInstance,
              fromInstance: donor,
              requested: domains.length,
              moved: [],
              uploading: [],
              skipped: [],
              error: `no Inboxing platform connection configured for ${p.targetInstance}`,
            });
            continue;
          }

          const res = await internalFetch("/api/deliverability/move-domains", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mode: "submit",
              dryRun: false,
              domains,
              targetInstance: p.targetInstance,
              platformConnectionId: connectionId,
            }),
          });
          const json = await res.json().catch(() => ({}));
          if (!res.ok || json?.error) {
            results.push({
              targetInstance: p.targetInstance,
              fromInstance: donor,
              requested: domains.length,
              moved: [],
              uploading: [],
              skipped: [],
              error: json?.error || `HTTP ${res.status}`,
            });
            continue;
          }

          const rows = (json.results || []) as { domain: string; status: string; error?: string }[];
          results.push({
            targetInstance: p.targetInstance,
            fromInstance: donor,
            requested: domains.length,
            moved: rows.filter((r) => r.status === "done").map((r) => r.domain),
            uploading: rows.filter((r) => r.status === "uploading").map((r) => r.domain),
            skipped: rows
              .filter((r) => r.status === "skipped" || r.status === "failed")
              .map((r) => ({ domain: r.domain, reason: r.error || r.status })),
          });
        } catch (e) {
          results.push({
            targetInstance: p.targetInstance,
            fromInstance: donor,
            requested: domains.length,
            moved: [],
            uploading: [],
            skipped: [],
            error: e instanceof Error ? e.message : "move failed",
          });
        }
      }
    }

    const movedTotal = results.reduce((s, r) => s + r.moved.length, 0);
    const uploadingTotal = results.reduce((s, r) => s + r.uploading.length, 0);

    return NextResponse.json({
      results,
      movedTotal,
      uploadingTotal,
      // The source copy is left in place on purpose — move-domains never
      // deletes. Nick asked (12:13) that the old copy go once the move is
      // confirmed; that is move-finalize's job, which auto-deletes a fully
      // verified source copy after its grace period.
      note:
        uploadingTotal > 0
          ? `${uploadingTotal} uploading — press Move again in a few minutes to finalize what has landed, then run the fill.`
          : "Run the fill next to tag, set redirects and attach campaigns.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "move-fill failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
