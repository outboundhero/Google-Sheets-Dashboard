import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
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
        .select("domain");

      if (error) {
        failed.push({ domain: t.domain, error: error.message });
      } else if (!data || data.length === 0) {
        failed.push({
          domain: t.domain,
          error: "not awaiting review (already fired, or no such row)",
        });
      } else {
        updated.push(t.domain);
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
                  ? `deletion rejected by review${body.note ? ` — ${body.note}` : ""}`
                  : `deletion held for review${body.note ? ` — ${body.note}` : ""}`,
          })),
      ).catch(() => {});
    }

    return NextResponse.json({
      decision,
      status,
      updated: updated.length,
      domains: updated,
      failed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "review failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
