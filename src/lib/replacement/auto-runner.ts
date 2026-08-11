// Auto-runner (Nick's "full-auto" ask): cron-driven execution of the
// replacement plan without a human click. HARD GATE: acts only while the
// admin-set guardrail Mode on /replacement is "auto" — observe/confirm make
// every invocation a no-op, so deploying this changes nothing until the mode
// dropdown is flipped. Detection source mirrors the group-plan card (Spencer's
// threshold groups when enabled, else flat guardrails); the skip/unflag list
// and the churn blackout apply exactly as they do for a manual Execute.
//
// Blast-radius bounds per invocation:
//   * at most MAX_CLIENTS (default 1) clients — executed domains leave the
//     plan (lifecycle "removed"), so successive runs naturally walk the queue;
//   * only clients with ≥1 ready replacement — remove-only/blocked clients
//     stay manual so full-auto never strips a client without giving back;
//   * a client isn't re-run within RECENT_HOURS (any execution event counts);
//   * cross-instance donor moves capped at MAX_CROSS_MOVES with a shortened
//     verify deadline that fits the cron's maxDuration.
import type { BisonInstanceSlug } from "@/lib/bison-instances";
import { getSettings, getEvents, logEvents } from "./store";
import { getThresholdConfig } from "./threshold-groups-store";
import { buildReplacementPlan, type PlanItem } from "./plan";
import { runExecution, type ExecStep, type ExecuteInputs } from "./execute-runner";
import { internalFetch } from "./internal-fetch";
import { inboxingConnectionFor } from "./inboxing-connections";

const RECENT_HOURS = 20;
const MAX_CROSS_MOVES = 2;
const MOVE_DEADLINE_MS = 4 * 60 * 1000;

export interface AutoRunResult {
  enabled: boolean;
  mode: string;
  detector: "groups" | "guardrails";
  dryRun: boolean;
  /** every (client, instance) group in the plan, with what it needs */
  candidates: { clientTag: string; instance: string; replaceReady: number; removeTotal: number; crossMoves: number }[];
  skipped: { clientTag: string; instance: string; reason: string }[];
  executed: { clientTag: string; instance: string; ok: boolean; steps: { label: string; state: string; note?: string }[] }[];
}

export async function runAutoReplacement(
  opts: { dryRun?: boolean; maxClients?: number } = {},
): Promise<AutoRunResult> {
  const dryRun = opts.dryRun ?? false;
  const maxClients = Math.max(1, Math.min(opts.maxClients ?? 1, 3));

  const settings = await getSettings();
  const result: AutoRunResult = {
    enabled: settings.mode === "auto",
    mode: settings.mode,
    detector: "guardrails",
    dryRun,
    candidates: [],
    skipped: [],
    executed: [],
  };
  // dry runs may preview the queue in any mode; real runs require mode=auto
  if (!result.enabled && !dryRun) return result;

  const groupCfg = await getThresholdConfig();
  result.detector = groupCfg.enabled ? "groups" : "guardrails";
  const plan = await buildReplacementPlan(
    groupCfg.enabled ? { burntSource: "groups", groupConfig: groupCfg } : {},
  );

  // group plan items per (clientTag, instance) — same shape startExec builds
  const groups = new Map<string, PlanItem[]>();
  for (const it of plan.items) {
    if (!it.clientTag) continue;
    const k = `${it.clientTag}|${it.instance}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(it);
  }

  // clients touched by ANY execution in the last RECENT_HOURS (manual or auto)
  const recentEvents = await getEvents(1000, { withinDays: 1 });
  const cutoff = Date.now() - RECENT_HOURS * 3600_000;
  const ranRecently = new Set(
    recentEvents
      .filter((e) => e.clientTag && e.instance && new Date(e.createdAt).getTime() >= cutoff)
      .map((e) => `${e.clientTag}|${e.instance}`),
  );

  // most replacement-ready first, then alphabetical — deterministic queue
  const ordered = [...groups.entries()]
    .map(([key, items]) => {
      const [clientTag, instance] = key.split("|");
      const ready = items.filter((i) => !i.removeOnly && i.blockers.length === 0 && i.replacementDomain);
      return { key, clientTag, instance, items, ready };
    })
    .sort((a, b) => b.ready.length - a.ready.length || a.clientTag.localeCompare(b.clientTag));

  for (const g of ordered) {
    result.candidates.push({
      clientTag: g.clientTag,
      instance: g.instance,
      replaceReady: g.ready.length,
      removeTotal: g.items.length,
      crossMoves: g.ready.filter((i) => i.replacementFrom && i.replacementFrom !== g.instance).length,
    });
  }

  let slots = maxClients;
  for (const g of ordered) {
    if (slots <= 0) break;
    if (ranRecently.has(g.key)) {
      result.skipped.push({ clientTag: g.clientTag, instance: g.instance, reason: `executed within last ${RECENT_HOURS}h` });
      continue;
    }
    if (g.ready.length === 0) {
      result.skipped.push({ clientTag: g.clientTag, instance: g.instance, reason: "no ready replacements (remove-only/blocked) — run manually" });
      continue;
    }
    slots--;

    // bound cross-instance moves per run; overflow donors wait for a later pass
    const crossAll = g.ready.filter((i) => i.replacementFrom && i.replacementFrom !== g.instance);
    const cross = crossAll.slice(0, MAX_CROSS_MOVES);
    const local = g.ready.filter((i) => !i.replacementFrom || i.replacementFrom === g.instance);
    const usedRepl = [...local, ...cross];

    const inputs: ExecuteInputs = {
      clientTag: g.clientTag,
      instance: g.instance,
      instancesQuery: `instances=${g.instance}`,
      redirectUrl: g.items.find((i) => i.redirectUrl)?.redirectUrl ?? null,
      targetCampaigns: (usedRepl[0]?.targetCampaigns ?? []).map((c) => ({ id: c.id, name: c.name })),
      replacementDomains: usedRepl.map((i) => i.replacementDomain!),
      removeDomains: g.items.map((i) => i.burntDomain),
      crossMoves: cross.map((i) => ({
        domain: i.replacementDomain!,
        fromInstance: i.replacementFrom!,
        platformConnectionId: inboxingConnectionFor(g.instance as BisonInstanceSlug),
      })),
    };

    if (dryRun) {
      result.executed.push({
        clientTag: g.clientTag, instance: g.instance, ok: true,
        steps: [{ label: `DRY — would replace ${usedRepl.length} (${cross.length} cross-move) · remove ${g.items.length}`, state: "queued" }],
      });
      continue;
    }

    // selection marker BEFORE running — doubles as the re-run guard even if
    // the invocation dies mid-execution
    await logEvents([{
      instance: g.instance as BisonInstanceSlug, clientTag: g.clientTag, eventType: "proposed",
      detail: `auto-runner: executing — ${usedRepl.length} replace (${cross.length} cross-move) · ${g.items.length} remove`,
    }]).catch(() => {});

    let lastSteps: ExecStep[] = [];
    const { ok } = await runExecution(inputs, (s) => { lastSteps = s; }, {
      fetchImpl: internalFetch,
      moveDeadlineMs: MOVE_DEADLINE_MS,
    });
    result.executed.push({
      clientTag: g.clientTag, instance: g.instance, ok,
      steps: lastSteps.map((s) => ({ label: s.label, state: s.state, note: s.note })),
    });
  }

  return result;
}
