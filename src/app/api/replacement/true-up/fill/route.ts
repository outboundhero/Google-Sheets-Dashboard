import { NextResponse } from "next/server";
import { computeTrueUp } from "@/lib/replacement/true-up";
import { runExecution, type ExecStep, type ExecuteInputs } from "@/lib/replacement/execute-runner";
import { internalFetch } from "@/lib/replacement/internal-fetch";
import { logEvents } from "@/lib/replacement/store";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

export const maxDuration = 300;

// POST /api/replacement/true-up/fill — runs the FILL half of the true-up.
//
// Nick 2026-08-13: a client under its tier cap should be topped back up to it,
// not just given one reserve per burnt domain. The nightly runner only ever
// adds alongside a removal, so a client sitting quietly under cap with nothing
// burnt never gets made whole. This is that path, and it is deliberately a
// button rather than a cron: it adds domains to live clients, so the first
// cycles get looked at before they go.
//
// Adds only — no removals, no trim, no vendor deletes. It reuses the same
// execution runner the queue and the auto-runner use, so tagging, redirect,
// campaign attach, sheet and whitelist all behave identically.
//
// Body:
//   { clientTag, instance }  run one client
//   { all: true }            run every fillable client, up to `maxClients`
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

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Body;
    const dryRun = body.dryRun === true;
    const maxClients = Math.max(1, Math.min(20, body.maxClients ?? DEFAULT_MAX_CLIENTS));

    const trueUp = await computeTrueUp();

    // Only rows that can actually run: reserve earmarked, a campaign to attach
    // to, and a redirect to point at. A row with a blocker is left alone rather
    // than half-executed.
    let targets = trueUp.rows.filter(
      (r) => r.fillCandidates.length > 0 && r.targetCampaigns.length > 0 && r.redirectUrl,
    );

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
        const row = trueUp.rows.find((r) => r.clientTag === tag && r.instance === instance);
        return NextResponse.json(
          {
            error: row
              ? `nothing runnable for ${tag} in ${instance}: ${
                  row.blockers.join(", ") || "already at cap"
                }`
              : `${tag} not found in ${instance}`,
          },
          { status: 400 },
        );
      }
    }

    // Biggest gaps first — a client 16 short matters more than one short by 1.
    targets = targets
      .sort((a, b) => b.fillCandidates.length - a.fillCandidates.length)
      .slice(0, maxClients);

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        wouldRun: targets.map((r) => ({
          clientTag: r.clientTag,
          instance: r.instance,
          cap: r.cap,
          staying: r.staying,
          adding: r.fillCandidates.length,
          stillShort: r.fillShort,
          domains: r.fillCandidates,
          campaigns: r.targetCampaigns.map((c) => c.name),
        })),
      });
    }

    const executed: {
      clientTag: string;
      instance: string;
      ok: boolean;
      added: number;
      steps: { label: string; state: string; note?: string }[];
    }[] = [];

    for (const r of targets) {
      const inputs: ExecuteInputs = {
        clientTag: r.clientTag,
        instance: r.instance,
        instancesQuery: `instances=${r.instance}`,
        redirectUrl: r.redirectUrl,
        targetCampaigns: r.targetCampaigns.map((c) => ({ id: c.id, name: c.name })),
        replacementDomains: r.fillCandidates,
        removeDomains: [], // fill never removes — that is the trim's job
      };

      // Marker before the run, so a died-mid-execution invocation still leaves
      // a trace of what was attempted (same contract as the auto-runner).
      await logEvents([
        {
          instance: r.instance as BisonInstanceSlug,
          clientTag: r.clientTag,
          eventType: "proposed",
          detail: `true-up fill: adding ${r.fillCandidates.length} to reach cap ${r.cap} (had ${r.staying})`,
        },
      ]).catch(() => {});

      let lastSteps: ExecStep[] = [];
      const { ok } = await runExecution(inputs, (s) => { lastSteps = s; }, {
        fetchImpl: internalFetch,
      });

      executed.push({
        clientTag: r.clientTag,
        instance: r.instance,
        ok,
        added: r.fillCandidates.length,
        steps: lastSteps.map((s) => ({ label: s.label, state: s.state, note: s.note })),
      });
    }

    return NextResponse.json({
      executed,
      ranClients: executed.length,
      addedTotal: executed.reduce((s, e) => s + (e.ok ? e.added : 0), 0),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "fill failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
