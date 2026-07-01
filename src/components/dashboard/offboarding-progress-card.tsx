"use client";

// Live-progress card for a single client offboarding, rendered at the TOP of
// the home dashboard. Confirmation happens elsewhere (a small dialog on the
// Churned clients row); once the user confirms, this card mounts with the
// plan already fetched, immediately walks the steps, and records the final
// result via POST /api/churn-offboarding (with allowInsert so an ad-hoc row
// is auto-created if the daily cron hasn't queued one yet).
import { useEffect, useRef, useState } from "react";
import {
  Loader2, CheckCircle2, Circle, AlertCircle, MinusCircle, RotateCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";

type StepKind = "pause-campaign" | "detag-inbox-batch" | "reaggregate-domains";
interface PlanStepBase { id: string; kind: StepKind; instance: string; label: string }
interface PauseCampaignStep extends PlanStepBase {
  kind: "pause-campaign"; campaignId: number; campaignName: string;
}
interface DetagInboxBatchStep extends PlanStepBase {
  kind: "detag-inbox-batch"; tagId: number; tagName: string; inboxIds: number[]; domains: string[];
}
interface ReaggregateDomainsStep extends PlanStepBase {
  kind: "reaggregate-domains"; domains: string[];
}
export type PlanStep = PauseCampaignStep | DetagInboxBatchStep | ReaggregateDomainsStep;

export interface OffboardingPlan {
  clientTag: string;
  instancesTargeted: string[];
  summary: { campaigns: number; inboxes: number; domains: number };
  perInstance: { instance: string; campaigns: number; inboxes: number; tagId: number | null }[];
  steps: PlanStep[];
}

interface StepResult {
  ok: boolean;
  error: string | null;
  skipped?: { reason: string };
  pausedCampaign?: { instance: string; id: number; name: string };
  detagged?: number;
  detagFailures?: { instance: string; inboxId: number; reason: string }[];
}

type StepState = "queued" | "running" | "done" | "skipped" | "failed";

async function callStep(step: PlanStep): Promise<StepResult> {
  const attempts = 3;
  let lastErr: string | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch("/api/churn-offboarding/execute-step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step }),
      });
      const text = await res.text();
      let json: StepResult | null = null;
      try { json = JSON.parse(text) as StepResult; }
      catch {
        lastErr = `non-JSON response (HTTP ${res.status}) — transient Vercel error`;
        if (attempt < attempts - 1) { await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); continue; }
        return { ok: false, error: lastErr };
      }
      if (!res.ok && !json.error) json.error = `HTTP ${res.status}`;
      return json;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : "request failed";
      if (attempt < attempts - 1) { await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); continue; }
      return { ok: false, error: lastErr };
    }
  }
  return { ok: false, error: lastErr || "request failed" };
}

function StatusDot({ state }: { state: StepState }) {
  if (state === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500 shrink-0" />;
  if (state === "done")    return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />;
  if (state === "skipped") return <MinusCircle className="h-3.5 w-3.5 text-zinc-400 dark:text-zinc-500 shrink-0" />;
  if (state === "failed")  return <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />;
  return <Circle className="h-3.5 w-3.5 text-zinc-300 dark:text-zinc-600 shrink-0" />;
}

interface Props {
  plan: OffboardingPlan;
  clientAbbr: string;
  churnDate: string;
  companyName: string;
  /** When true, POST /api/churn-offboarding allowed to insert a fresh pending
   *  row if none exists (ad-hoc offboardings from the Churned clients card). */
  allowInsert?: boolean;
  onDismiss: () => void;
  /** Fires with true when the walk finishes (success or with errors) so the
   *  Churned clients list can refetch tracker data etc. */
  onFinished?: (ok: boolean) => void;
}

export function OffboardingProgressCard({
  plan, clientAbbr, churnDate, companyName, allowInsert, onDismiss, onFinished,
}: Props) {
  const [stepStates, setStepStates] = useState<Record<string, StepState>>(() => {
    const s: Record<string, StepState> = {};
    for (const step of plan.steps) s[step.id] = "queued";
    return s;
  });
  const [stepNotes, setStepNotes] = useState<Record<string, { tone: "error" | "muted"; text: string }>>({});
  const [tally, setTally] = useState({ paused: 0, pauseSkipped: 0, pauseFailed: 0, detagged: 0, detagFailed: 0 });
  const [running, setRunning] = useState(true);
  const [finished, setFinished] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const startedRef = useRef(false);

  const pauseSteps = plan.steps.filter((s): s is PauseCampaignStep => s.kind === "pause-campaign");
  const detagSteps = plan.steps.filter((s): s is DetagInboxBatchStep => s.kind === "detag-inbox-batch");
  const reaggSteps = plan.steps.filter((s): s is ReaggregateDomainsStep => s.kind === "reaggregate-domains");

  useEffect(() => {
    // Guard against React StrictMode double-mounts kicking two walkers.
    if (startedRef.current) return;
    startedRef.current = true;

    (async () => {
      const pausedCampaigns: { instance: string; id: number; name: string }[] = [];
      const pauseSkipped: { instance: string; id: number; name: string; reason: string }[] = [];
      const pauseFailures: { instance: string; id: number; name: string; error: string }[] = [];
      const detagFailures: { instance: string; inboxId: number; reason: string }[] = [];
      const errors: string[] = [];
      let detaggedTotal = 0;
      const affectedDomainPairs = new Set<string>();

      for (const step of plan.steps) {
        setStepStates((p) => ({ ...p, [step.id]: "running" }));
        const result = await callStep(step);

        if (step.kind === "pause-campaign") {
          if (result.ok && result.pausedCampaign) {
            pausedCampaigns.push(result.pausedCampaign);
            setStepStates((p) => ({ ...p, [step.id]: "done" }));
            setTally((t) => ({ ...t, paused: t.paused + 1 }));
          } else if (result.skipped) {
            pauseSkipped.push({
              instance: step.instance, id: step.campaignId, name: step.campaignName,
              reason: result.skipped.reason,
            });
            setStepStates((p) => ({ ...p, [step.id]: "skipped" }));
            setStepNotes((p) => ({ ...p, [step.id]: { tone: "muted", text: result.skipped!.reason } }));
            setTally((t) => ({ ...t, pauseSkipped: t.pauseSkipped + 1 }));
          } else {
            pauseFailures.push({
              instance: step.instance, id: step.campaignId, name: step.campaignName,
              error: result.error || "pause failed",
            });
            setStepStates((p) => ({ ...p, [step.id]: "failed" }));
            if (result.error) setStepNotes((p) => ({ ...p, [step.id]: { tone: "error", text: result.error! } }));
            setTally((t) => ({ ...t, pauseFailed: t.pauseFailed + 1 }));
          }
        } else if (step.kind === "detag-inbox-batch") {
          const n = result.detagged || 0;
          detaggedTotal += n;
          setTally((t) => ({
            ...t,
            detagged: t.detagged + n,
            detagFailed: t.detagFailed + (result.detagFailures?.length || 0),
          }));
          if (result.detagFailures) detagFailures.push(...result.detagFailures);
          for (const d of step.domains) affectedDomainPairs.add(`${step.instance}:${d}`);
          setStepStates((p) => ({ ...p, [step.id]: result.ok ? "done" : "failed" }));
          if (!result.ok && result.error) {
            errors.push(`[${step.instance}] detag: ${result.error}`);
            setStepNotes((p) => ({ ...p, [step.id]: { tone: "error", text: result.error! } }));
          }
        } else if (step.kind === "reaggregate-domains") {
          setStepStates((p) => ({ ...p, [step.id]: result.ok ? "done" : "failed" }));
          if (!result.ok && result.error) {
            errors.push(`[${step.instance}] reaggregate: ${result.error}`);
            setStepNotes((p) => ({ ...p, [step.id]: { tone: "error", text: result.error! } }));
          }
        }
      }

      // Record the final result. `allowInsert` lets the server create a row
      // when the daily cron hasn't queued one yet (ad-hoc from Churned clients).
      try {
        const res = await fetch("/api/churn-offboarding", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientAbbr, churnDate, decision: "confirm", allowInsert: allowInsert ?? false,
            result: {
              clientTag: plan.clientTag,
              instancesTargeted: plan.instancesTargeted,
              pausedCampaigns, pauseSkipped, pauseFailures,
              inboxesDetagged: detaggedTotal, detagFailures,
              affectedDomains: affectedDomainPairs.size,
              errors,
            },
          }),
        });
        const json = await res.json();
        if (!res.ok) setRecordError(json?.error || `HTTP ${res.status}`);
      } catch (e) {
        setRecordError(e instanceof Error ? e.message : "record failed");
      }

      setRunning(false);
      setFinished(true);
      onFinished?.(pauseFailures.length === 0 && detagFailures.length === 0);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalSteps = plan.steps.length;
  const doneSteps = Object.values(stepStates).filter(
    (s) => s === "done" || s === "skipped" || s === "failed",
  ).length;
  const pausedProgress = pauseSteps.filter((s) => stepStates[s.id] === "done" || stepStates[s.id] === "skipped" || stepStates[s.id] === "failed").length;
  const detagProgress = detagSteps.filter((s) => stepStates[s.id] === "done" || stepStates[s.id] === "failed").length;
  const reaggProgress = reaggSteps.filter((s) => stepStates[s.id] === "done" || stepStates[s.id] === "failed").length;

  function pauseTallyText(): string {
    const parts = [`${tally.paused} paused`];
    if (tally.pauseSkipped) parts.push(`${tally.pauseSkipped} already deleted in Bison`);
    if (tally.pauseFailed) parts.push(`${tally.pauseFailed} failed`);
    return parts.join(" · ");
  }

  return (
    <div className="rounded-xl border-2 border-amber-400 dark:border-amber-600 bg-amber-50 dark:bg-amber-950/30 p-4">
      <div className="flex items-start gap-3 mb-3">
        {running ? (
          <Loader2 className="h-5 w-5 animate-spin text-amber-500 shrink-0 mt-0.5" />
        ) : (
          <CheckCircle2 className="h-5 w-5 text-emerald-500 shrink-0 mt-0.5" />
        )}
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-amber-700 dark:text-amber-200">
            {running ? "Offboarding" : "Offboarding complete"} — {companyName}{" "}
            <span className="font-normal text-amber-600/70 dark:text-amber-400/60">({clientAbbr})</span>
          </h3>
          <p className="text-[11px] text-amber-600/70 dark:text-amber-400/70">
            {doneSteps}/{totalSteps} steps · {pauseTallyText()} · {tally.detagged.toLocaleString("en-US")}/{plan.summary.inboxes.toLocaleString("en-US")} inboxes detagged
            {tally.detagFailed ? ` · ${tally.detagFailed} inbox failures` : ""}
          </p>
        </div>
        {finished && (
          <Button size="sm" variant="ghost" className="h-7 text-xs shrink-0" onClick={onDismiss}>
            Dismiss
          </Button>
        )}
      </div>

      {recordError && (
        <div className="text-xs text-red-600 dark:text-red-400 mb-2">Failed to record decision: {recordError}</div>
      )}

      <div className="space-y-3">
        {pauseSteps.length > 0 && (
          <Section title={`Pause campaigns (${pausedProgress}/${pauseSteps.length}) — ${pauseTallyText()}`}>
            <ul className="space-y-1 max-h-40 overflow-y-auto text-xs pr-1">
              {pauseSteps.map((s) => {
                const state = stepStates[s.id] || "queued";
                const note = stepNotes[s.id];
                return (
                  <li
                    key={s.id}
                    className={`flex items-center gap-2 px-1 py-0.5 ${state === "skipped" ? "opacity-60" : ""}`}
                  >
                    <StatusDot state={state} />
                    <span className="truncate flex-1">
                      <span className="text-muted-foreground mr-1">[{s.instance}]</span>{s.campaignName}
                    </span>
                    {note && (
                      <span
                        className={`text-[10px] truncate max-w-[180px] italic ${note.tone === "error" ? "text-red-500" : "text-muted-foreground"}`}
                        title={note.text}
                      >
                        {note.text}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </Section>
        )}

        {detagSteps.length > 0 && (
          <Section title={`Detag inboxes (${tally.detagged.toLocaleString("en-US")}/${plan.summary.inboxes.toLocaleString("en-US")})`}>
            <div className="space-y-1">
              <div className="h-1.5 rounded-full bg-amber-200 dark:bg-amber-900/40 overflow-hidden">
                <div
                  className="h-full bg-amber-500 transition-all"
                  style={{ width: `${Math.min(100, (tally.detagged / Math.max(1, plan.summary.inboxes)) * 100)}%` }}
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Batch {detagProgress}/{detagSteps.length} · {tally.detagFailed} inbox failure{tally.detagFailed === 1 ? "" : "s"}
              </p>
            </div>
          </Section>
        )}

        {reaggSteps.length > 0 && (
          <Section title={`Refresh deliverability domain rollups (${reaggProgress}/${reaggSteps.length})`}>
            <ul className="space-y-1 text-xs">
              {reaggSteps.map((s) => (
                <li key={s.id} className="flex items-center gap-2 px-1 py-0.5">
                  <StatusDot state={stepStates[s.id] || "queued"} />
                  <span className="truncate flex-1">
                    <span className="text-muted-foreground mr-1">[{s.instance}]</span>{s.domains.length} domain{s.domains.length === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>

      {finished && (recordError || pauseSteps.some((s) => stepStates[s.id] === "failed") || detagSteps.some((s) => stepStates[s.id] === "failed")) && (
        <div className="mt-3 text-[11px] text-muted-foreground flex items-center gap-1">
          <RotateCw className="h-3 w-3" /> Some steps failed. Re-run from the Pending offboardings card to retry.
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-xs font-semibold text-amber-800/80 dark:text-amber-200/70 mb-1.5">{title}</h4>
      {children}
    </div>
  );
}
