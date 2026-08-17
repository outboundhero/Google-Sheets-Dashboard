import { NextResponse } from "next/server";
import { computeTrueUp } from "@/lib/replacement/true-up";
import { internalFetch } from "@/lib/replacement/internal-fetch";
import { logEvents } from "@/lib/replacement/store";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

export const maxDuration = 300;

// POST /api/replacement/true-up/trim — runs the TRIM half of the true-up.
//
// Nick 2026-08-17: "We do want this" — a client over its tier cap gives its
// weakest domains back, and they return to the reserve untagged with the
// redirect removed, ready to be reallocated to whoever is short.
//
// The crucial difference from the burnt-domain path in execute-runner: a
// trimmed domain is HEALTHY. It must not be scheduled for vendor deletion, so
// this route deliberately does not write `replacement_cancellations` and does
// not mark the domain `removed` in the lifecycle. It only:
//
//   1. detaches the domain from the client's campaigns
//   2. removes the client tag from every inbox on it
//   3. clears the redirect
//
// After that the domain is untagged and warm, which is exactly what the fill
// half already looks for — so reallocation needs no extra machinery. Run the
// fill after a trim and the freed domains flow to the short clients.
//
// Body:
//   { clientTag, instance }  trim one client
//   { all: true }            trim every over-cap client, up to `maxClients`
//   { dryRun: true }         report what it would do and stop
//   { maxClients }           bound a bulk run (default 5)

const DEFAULT_MAX_CLIENTS = 5;

interface Body {
  clientTag?: string;
  instance?: string;
  all?: boolean;
  dryRun?: boolean;
  maxClients?: number;
}

type StepState = "done" | "failed" | "skipped";
interface TrimStep {
  label: string;
  state: StepState;
  note?: string;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Body;
    const dryRun = body.dryRun === true;
    const maxClients = Math.max(1, Math.min(20, body.maxClients ?? DEFAULT_MAX_CLIENTS));

    const trueUp = await computeTrueUp();

    // Only rows that are genuinely over cap and have candidates picked out.
    let targets = trueUp.rows.filter((r) => r.trimNeeded > 0 && r.trimCandidates.length > 0);

    if (!body.all) {
      const tag = (body.clientTag || "").trim().toUpperCase();
      const instance = (body.instance || "").trim();
      if (!tag || !instance) {
        return NextResponse.json(
          { error: "clientTag + instance required, or pass { all: true }" },
          { status: 400 },
        );
      }
      targets = targets.filter((r) => r.clientTag === tag && r.instance === instance);
      if (targets.length === 0) {
        return NextResponse.json(
          { error: `nothing to trim for ${tag} in ${instance} — it is at or under cap` },
          { status: 400 },
        );
      }
    }

    // Biggest overage first, same ordering rationale as the fill.
    targets = targets.sort((a, b) => b.trimNeeded - a.trimNeeded).slice(0, maxClients);

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        wouldRun: targets.map((r) => ({
          clientTag: r.clientTag,
          instance: r.instance,
          cap: r.cap,
          staying: r.staying,
          trimming: r.trimCandidates.length,
          unproven: r.trimUnproven,
          domains: r.trimCandidates.map((c) => c.domain),
          candidates: r.trimCandidates,
        })),
      });
    }

    const executed: {
      clientTag: string;
      instance: string;
      ok: boolean;
      trimmed: number;
      domains: string[];
      steps: TrimStep[];
    }[] = [];

    for (const r of targets) {
      const domains = r.trimCandidates.map((c) => c.domain);
      const instancesQuery = `instances=${r.instance}`;
      const steps: TrimStep[] = [];

      // Marker first, so an invocation that dies mid-run still leaves a trace.
      await logEvents([
        {
          instance: r.instance as BisonInstanceSlug,
          clientTag: r.clientTag,
          eventType: "proposed",
          detail: `true-up trim: returning ${domains.length} to reserve (cap ${r.cap}, had ${r.staying})`,
        },
      ]).catch(() => {});

      const callJson = async (path: string, payload: unknown) => {
        try {
          const res = await internalFetch(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const json = await res.json().catch(() => ({}));
          if (!res.ok || json?.error) {
            return { ok: false, error: json?.error || `HTTP ${res.status}` };
          }
          return { ok: true, json };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : "request failed" };
        }
      };

      // 1. Detach from the client's campaigns. `discover: true` finds which
      //    campaigns actually hold them rather than trusting our own map.
      const det = await callJson(`/api/deliverability/remove-from-campaigns?${instancesQuery}`, {
        domains,
        discover: true,
      });
      steps.push({
        label: `Detach ${domains.length} domain(s) from campaigns`,
        state: det.ok ? "done" : "failed",
        note: det.ok ? undefined : det.error,
      });

      // 2. Drop the client tag. Name-based so it resolves per instance.
      const untag = await callJson("/api/deliverability/bulk-tags", {
        action: "remove",
        tagNames: [r.clientTag],
        domains,
      });
      steps.push({
        label: `Remove ${r.clientTag} tag`,
        state: untag.ok ? "done" : "failed",
        note: untag.ok ? undefined : untag.error,
      });

      // 3. Clear the redirect so the domain carries nothing client-specific.
      //    `clearRedirect` is the explicit signal — a blank newUrl is rejected
      //    by that route on purpose, so an empty submit can't wipe redirects.
      const redir = await callJson("/api/deliverability/change-redirect", {
        dryRun: false,
        domains,
        clearRedirect: true,
      });
      steps.push({
        label: "Clear redirect",
        state: redir.ok ? "done" : "failed",
        note: redir.ok ? undefined : redir.error,
      });

      const ok = steps.every((s) => s.state !== "failed");

      // Logged as `removed` because that is the closest existing event type —
      // but note the detail line, and note what is NOT here: no
      // `cancellations` and no lifecycle write. That is the whole difference
      // between a trim and a burnt-domain removal. A trimmed domain must stay
      // out of the vendor-delete bridge, which only ever reads
      // `replacement_cancellations`.
      await logEvents(
        domains.map((d) => ({
          instance: r.instance as BisonInstanceSlug,
          domain: d,
          clientTag: r.clientTag,
          eventType: ok ? ("removed" as const) : ("error" as const),
          detail: ok
            ? "trimmed (over cap) — healthy, returned to reserve untagged, redirect cleared, NOT scheduled for deletion"
            : `trim incomplete: ${steps.filter((s) => s.state === "failed").map((s) => s.label).join(", ")}`,
        })),
      ).catch(() => {});

      executed.push({
        clientTag: r.clientTag,
        instance: r.instance,
        ok,
        trimmed: domains.length,
        domains,
        steps,
      });
    }

    return NextResponse.json({
      executed,
      ranClients: executed.length,
      trimmedTotal: executed.reduce((s, e) => s + (e.ok ? e.trimmed : 0), 0),
      // Trimmed domains are untagged and warm, so the fill will pick them up on
      // its next run — that is the reallocation Nick asked for.
      note: "Trimmed domains are back in the reserve. Run the fill to reallocate them.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "trim failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
