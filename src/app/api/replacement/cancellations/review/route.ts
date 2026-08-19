import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { internalFetch } from "@/lib/replacement/internal-fetch";

// Rejects release domains via campaign discovery + Bison calls — allow time.
export const maxDuration = 300;
import { logEvents } from "@/lib/replacement/store";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

// POST /api/replacement/cancellations/review — the human approve gate on
// burnt-domain deletion.
//
// Nick 2026-08-17 asked for a review step: see the burnt domains, approve them,
// and only then have them deleted with the provider cancellation sent.
//
// NOTE A CONFLICT worth knowing before this is switched on: Spencer signed off
// auto-fire on 2026-06-26 ("after the 5-day grace it auto-submits, no further
// approval"). The bridge fires on `status = 'pending'`, so today every burnt
// domain deletes itself once its grace elapses. This route does not change
// that default — it only acts on rows a human has explicitly touched:
//
//   approve → status stays/returns to 'pending'  (bridge will fire it)
//   reject  → status becomes 'aborted'           (bridge skips it forever)
//   hold    → status becomes 'held'              (bridge skips until approved)
//
// Reject ALSO releases the domain (Nick 2026-08-19, the BAJFI/ABM question):
// an aborted row used to leave the domain tagged to the client but out of its
// campaigns and out of every true-up count — a zombie that inflated the
// dashboard's domain count with nothing ever able to touch it (BAJFI showed
// 38 tagged while the system correctly held the client at 20 staying). Keep
// now means keep the domain ALIVE: untag it back to reserve, clear the
// redirect and drop its replacement-state row, same recipe as the trim.
//
// To make approval MANDATORY rather than optional, the writer in
// store.ts must insert `status: 'held'` instead of `'pending'`. That is a
// one-word change but it reverses Spencer's decision, so it is deliberately
// NOT done here — it needs Nick and Spencer to agree first.
//
// Body: { decision: "approve" | "reject" | "hold", domains: [{instance, domain}], note? }

type Decision = "approve" | "reject" | "hold";

const NEXT_STATUS: Record<Decision, string> = {
  approve: "pending",
  reject: "aborted",
  hold: "held",
};

interface Body {
  decision?: Decision;
  domains?: { instance?: string; domain?: string }[];
  note?: string;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Body;
    const decision = body.decision;
    if (!decision || !(decision in NEXT_STATUS)) {
      return NextResponse.json(
        { error: "decision must be one of: approve, reject, hold" },
        { status: 400 },
      );
    }

    const targets = (body.domains || [])
      .map((d) => ({
        instance: String(d.instance || "").trim(),
        domain: String(d.domain || "").trim().toLowerCase(),
      }))
      .filter((d) => d.instance && d.domain);

    if (targets.length === 0) {
      return NextResponse.json({ error: "domains required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const status = NEXT_STATUS[decision];
    const updated: string[] = [];
    const failed: { domain: string; error: string }[] = [];
    const releases: { instance: string; domain: string; clientTag: string | null }[] = [];

    const groupReleases = (list: typeof releases) => {
      const m = new Map<string, typeof releases>();
      for (const r of list) {
        const k = `${r.instance}|${r.clientTag ?? ""}`;
        m.set(k, [...(m.get(k) ?? []), r]);
      }
      return m;
    };

    const callInternal = async (path: string, payload: unknown) => {
      try {
        const res = await internalFetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json?.error) return { ok: false as const, error: json?.error || `HTTP ${res.status}` };
        return { ok: true as const, json: json as Record<string, unknown> };
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : "request failed" };
      }
    };

    for (const t of targets) {
      // Only move rows that are still awaiting a decision. A row the bridge has
      // already fired ('scheduled'/'done') must not be dragged back.
      const patch: Record<string, unknown> = { status };
      if (body.note) patch.reason = body.note;

      const { data, error } = await supabase
        .from("replacement_cancellations")
        .update(patch)
        .eq("instance", t.instance)
        .eq("domain", t.domain)
        .in("status", ["pending", "held", "stale-hold"])
        .select("domain, client_tag");

      if (error) {
        failed.push({ domain: t.domain, error: error.message });
      } else if (!data || data.length === 0) {
        failed.push({
          domain: t.domain,
          error: "not awaiting review (already fired, or no such row)",
        });
      } else {
        updated.push(t.domain);
        if (decision === "reject") {
          releases.push({
            instance: t.instance,
            domain: t.domain,
            clientTag: (data[0] as { client_tag?: string | null }).client_tag || null,
          });
        }
      }
    }

    // Release each kept domain back to reserve — grouped by (instance, tag)
    // so one bulk call covers a whole client's batch. Best-effort per group:
    // a failed release leaves the row aborted (safe) and reports the error.
    const released: string[] = [];
    for (const [key, group] of groupReleases(releases)) {
      const [instance, clientTag] = key.split("|");
      const domains = group.map((g) => g.domain);

      // Two calls by contract: discover returns the plan, posting the plan
      // back as `campaigns` performs the removal.
      const plan = await callInternal(
        `/api/deliverability/remove-from-campaigns?instances=${instance}`,
        { domains, discover: true },
      );
      const planCampaigns =
        plan.ok && Array.isArray(plan.json?.campaigns) ? (plan.json.campaigns as unknown[]) : [];
      const detach =
        planCampaigns.length > 0
          ? await callInternal(`/api/deliverability/remove-from-campaigns?instances=${instance}`, {
              domains,
              campaigns: planCampaigns,
            })
          : plan;
      const untag = clientTag
        ? await callInternal("/api/deliverability/bulk-tags", {
            action: "remove",
            tagNames: [clientTag],
            domains,
          })
        : { ok: true as const };
      const redir = await callInternal("/api/deliverability/change-redirect", {
        dryRun: false,
        domains,
        clearRedirect: true,
      });
      await supabase
        .from("domain_replacement_state")
        .delete()
        .eq("instance", instance)
        .in("domain", domains);

      if (detach.ok && untag.ok && redir.ok) {
        released.push(...domains);
      } else {
        for (const d of domains) {
          failed.push({
            domain: d,
            error: `kept (aborted) but release incomplete: ${[
              !detach.ok && "detach",
              !untag.ok && "untag",
              !redir.ok && "redirect",
            ]
              .filter(Boolean)
              .join("+")} failed`,
          });
        }
      }
    }

    if (updated.length > 0) {
      await logEvents(
        targets
          .filter((t) => updated.includes(t.domain))
          .map((t) => ({
            instance: t.instance as BisonInstanceSlug,
            domain: t.domain,
            clientTag: null,
            eventType: decision === "reject" ? ("skipped" as const) : ("cancel_queued" as const),
            detail:
              decision === "approve"
                ? `deletion approved by review${body.note ? ` — ${body.note}` : ""}`
                : decision === "reject"
                  ? `kept by review — released to reserve (untagged, redirect cleared)${body.note ? ` — ${body.note}` : ""}`
                  : `deletion held for review${body.note ? ` — ${body.note}` : ""}`,
          })),
      ).catch(() => {});
    }

    return NextResponse.json({
      decision,
      status,
      updated: updated.length,
      domains: updated,
      released,
      failed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "review failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
