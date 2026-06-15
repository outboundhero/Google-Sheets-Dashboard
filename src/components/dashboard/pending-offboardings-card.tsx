"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, CheckCircle2, XCircle, Circle, AlertCircle, MinusCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useOffboardings, type OffboardingItem } from "@/lib/hooks/use-pending-offboardings";

type StepKind = "pause-campaign" | "detag-inbox-batch" | "reaggregate-domains";

interface PlanStepBase {
  id: string;
  kind: StepKind;
  instance: string;
  label: string;
}
interface PauseCampaignStep extends PlanStepBase {
  kind: "pause-campaign";
  campaignId: number;
  campaignName: string;
}
interface DetagInboxBatchStep extends PlanStepBase {
  kind: "detag-inbox-batch";
  tagId: number;
  tagName: string;
  inboxIds: number[];
  domains: string[];
}
interface ReaggregateDomainsStep extends PlanStepBase {
  kind: "reaggregate-domains";
  domains: string[];
}
type PlanStep = PauseCampaignStep | DetagInboxBatchStep | ReaggregateDomainsStep;

interface Plan {
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

// Walk one /execute-step request with up to 2 retries on transient errors
// (network blip, Vercel cold-start returning HTML, JSON parse error). Each
// retry waits a bit longer. The pause/detag operations are idempotent so a
// retry that lands on a successful previous attempt still returns ok.
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
        lastErr = `non-JSON response (HTTP ${res.status}) — likely a transient Vercel error`;
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

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map((s) => parseInt(s, 10));
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

function StatusDot({ state }: { state: StepState }) {
  if (state === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500 shrink-0" />;
  if (state === "done")    return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />;
  if (state === "skipped") return <MinusCircle className="h-3.5 w-3.5 text-zinc-400 dark:text-zinc-500 shrink-0" />;
  if (state === "failed")  return <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />;
  return <Circle className="h-3.5 w-3.5 text-zinc-300 dark:text-zinc-600 shrink-0" />;
}

export function PendingOffboardingsCard() {
  const { pending, isLoading, mutate } = useOffboardings();
  const [item, setItem] = useState<OffboardingItem | null>(null);
  const [skipItem, setSkipItem] = useState<OffboardingItem | null>(null);

  if (isLoading || pending.length === 0) return null;

  return (
    <>
      <div className="rounded-xl border-2 border-amber-400 dark:border-amber-600 bg-amber-50 dark:bg-amber-950/30 p-4">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle className="h-4.5 w-4.5 text-amber-500 dark:text-amber-400 shrink-0" />
          <div>
            <h3 className="text-sm font-semibold text-amber-700 dark:text-amber-200">Pending offboardings</h3>
            <p className="text-[11px] text-amber-600/70 dark:text-amber-400/70">
              {pending.length} client{pending.length === 1 ? "" : "s"} need a decision — auto-fires 9 AM PST the day after the churn date
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          {pending.map((p) => (
            <div
              key={`${p.clientAbbr}|${p.churnDate}`}
              className="flex items-center justify-between rounded-lg bg-amber-100 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800/40 px-3 py-2 text-sm gap-2"
            >
              <div className="min-w-0 flex-1">
                <span className="font-medium text-amber-800 dark:text-amber-100 truncate">
                  {p.companyName}{" "}
                  <span className="font-normal text-amber-600/70 dark:text-amber-400/60">({p.clientAbbr})</span>
                </span>
                <span className="ml-2 text-[10px] text-amber-700 dark:text-amber-300 bg-amber-200 dark:bg-amber-900/60 rounded px-1.5 py-0.5">
                  churn {formatDate(p.churnDate)}
                </span>
              </div>
              <div className="flex gap-2 shrink-0">
                <Button
                  size="sm"
                  variant="default"
                  className="bg-amber-600 hover:bg-amber-700 text-white"
                  onClick={() => setItem(p)}
                >
                  Offboard
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSkipItem(p)}>
                  Skip
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {item && (
        <OffboardDialog
          item={item}
          onClose={(refresh) => {
            setItem(null);
            if (refresh) mutate();
          }}
        />
      )}

      {skipItem && (
        <SkipDialog
          item={skipItem}
          onClose={(refresh) => {
            setSkipItem(null);
            if (refresh) mutate();
          }}
        />
      )}
    </>
  );
}

// ===== Offboard dialog (plan + walk) =====

function OffboardDialog({ item, onClose }: { item: OffboardingItem; onClose: (refresh: boolean) => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loadingPlan, setLoadingPlan] = useState(true);
  const [planError, setPlanError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [stepStates, setStepStates] = useState<Record<string, StepState>>({});
  const [stepNotes, setStepNotes] = useState<Record<string, { tone: "error" | "muted"; text: string }>>({});
  const [tally, setTally] = useState({ paused: 0, pauseSkipped: 0, pauseFailed: 0, detagged: 0, detagFailed: 0 });
  const [recordError, setRecordError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/churn-offboarding/plan?clientAbbr=${encodeURIComponent(item.clientAbbr)}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.error) setPlanError(j.error);
        else {
          setPlan(j);
          const initial: Record<string, StepState> = {};
          for (const s of j.steps as PlanStep[]) initial[s.id] = "queued";
          setStepStates(initial);
        }
      })
      .catch((e) => { if (!cancelled) setPlanError(e instanceof Error ? e.message : "plan failed"); })
      .finally(() => { if (!cancelled) setLoadingPlan(false); });
    return () => { cancelled = true; };
  }, [item.clientAbbr]);

  const pauseSteps = (plan?.steps || []).filter((s): s is PauseCampaignStep => s.kind === "pause-campaign");
  const detagSteps = (plan?.steps || []).filter((s): s is DetagInboxBatchStep => s.kind === "detag-inbox-batch");
  const reaggSteps = (plan?.steps || []).filter((s): s is ReaggregateDomainsStep => s.kind === "reaggregate-domains");

  async function start() {
    if (!plan) return;
    setRunning(true);
    setRecordError(null);

    const pausedCampaigns: { instance: string; id: number; name: string }[] = [];
    const pauseSkipped: { instance: string; id: number; name: string; reason: string }[] = [];
    const pauseFailures: { instance: string; id: number; name: string; error: string }[] = [];
    const detagFailures: { instance: string; inboxId: number; reason: string }[] = [];
    const errors: string[] = [];
    let detaggedTotal = 0;
    const affectedDomainPairs = new Set<string>();

    for (const step of plan.steps) {
      setStepStates((prev) => ({ ...prev, [step.id]: "running" }));
      const result = await callStep(step);

      if (step.kind === "pause-campaign") {
        if (result.ok && result.pausedCampaign) {
          pausedCampaigns.push(result.pausedCampaign);
          setStepStates((p) => ({ ...p, [step.id]: "done" }));
          setTally((t) => ({ ...t, paused: t.paused + 1 }));
        } else if (result.skipped) {
          pauseSkipped.push({
            instance: step.instance,
            id: step.campaignId,
            name: step.campaignName,
            reason: result.skipped.reason,
          });
          setStepStates((p) => ({ ...p, [step.id]: "skipped" }));
          setStepNotes((p) => ({ ...p, [step.id]: { tone: "muted", text: result.skipped!.reason } }));
          setTally((t) => ({ ...t, pauseSkipped: t.pauseSkipped + 1 }));
        } else {
          pauseFailures.push({
            instance: step.instance,
            id: step.campaignId,
            name: step.campaignName,
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

    // Record the final result so the row flips to "confirmed".
    try {
      const res = await fetch("/api/churn-offboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientAbbr: item.clientAbbr,
          churnDate: item.churnDate,
          decision: "confirm",
          result: {
            clientTag: plan.clientTag,
            instancesTargeted: plan.instancesTargeted,
            pausedCampaigns,
            pauseSkipped,
            pauseFailures,
            inboxesDetagged: detaggedTotal,
            detagFailures,
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
  }

  const totalSteps = plan?.steps.length || 0;
  const doneSteps = Object.values(stepStates).filter(
    (s) => s === "done" || s === "skipped" || s === "failed",
  ).length;
  function tallyText(): string {
    const parts = [`${tally.paused} paused`];
    if (tally.pauseSkipped) parts.push(`${tally.pauseSkipped} already deleted in Bison`);
    if (tally.pauseFailed) parts.push(`${tally.pauseFailed} failed`);
    return parts.join(" · ");
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !running) onClose(finished); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Offboard {item.companyName}</DialogTitle>
          <DialogDescription>
            Pauses every active campaign for the <strong>{item.clientAbbr}</strong> tag and detaches the tag from every inbox carrying it. The tag itself stays alive in the Bison instance.
          </DialogDescription>
        </DialogHeader>

        {loadingPlan && (
          <div className="flex items-center gap-2 text-sm text-zinc-500 py-6">
            <Loader2 className="h-4 w-4 animate-spin" /> Planning the offboarding…
          </div>
        )}

        {planError && (
          <div className="text-sm text-red-600 dark:text-red-400 py-2">{planError}</div>
        )}

        {plan && (
          <>
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 text-sm space-y-1.5">
              <div className="flex justify-between">
                <span className="text-zinc-500">Campaigns to pause</span>
                <span className="font-medium text-right">
                  {running || finished
                    ? tallyText()
                    : plan.summary.campaigns.toLocaleString("en-US")}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Inboxes to detag</span>
                <span className="font-medium">
                  {running || finished
                    ? `${tally.detagged.toLocaleString("en-US")}/${plan.summary.inboxes.toLocaleString("en-US")}${tally.detagFailed ? ` (${tally.detagFailed} failed)` : ""}`
                    : plan.summary.inboxes.toLocaleString("en-US")}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Affected domains</span>
                <span className="font-medium">{plan.summary.domains.toLocaleString("en-US")}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Instances</span>
                <span className="font-medium text-right">
                  {plan.perInstance
                    .filter((p) => p.campaigns > 0 || p.inboxes > 0)
                    .map((p) => `${p.instance} (${p.campaigns}c, ${p.inboxes}i)`)
                    .join(", ") || plan.instancesTargeted.join(", ")}
                </span>
              </div>
            </div>

            {(running || finished) && (
              <div className="space-y-3">
                {pauseSteps.length > 0 && (
                  <Section title={`Pause campaigns — ${tallyText()}`}>
                    <ul className="space-y-1 max-h-44 overflow-y-auto text-xs">
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
                              <span className="text-zinc-500 mr-1">[{s.instance}]</span>{s.campaignName}
                            </span>
                            {note && (
                              <span
                                className={`text-[10px] truncate max-w-[180px] italic ${note.tone === "error" ? "text-red-500" : "text-zinc-500"}`}
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
                      <div className="h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
                        <div
                          className="h-full bg-amber-500 transition-all"
                          style={{ width: `${Math.min(100, (tally.detagged / Math.max(1, plan.summary.inboxes)) * 100)}%` }}
                        />
                      </div>
                      <p className="text-[11px] text-zinc-500">
                        Batch {detagSteps.filter((s) => stepStates[s.id] === "done" || stepStates[s.id] === "failed").length}/{detagSteps.length} •
                        {" "}{tally.detagFailed} inbox failure{tally.detagFailed === 1 ? "" : "s"}
                      </p>
                    </div>
                  </Section>
                )}

                {reaggSteps.length > 0 && (
                  <Section title={`Refresh deliverability domain rollups (${reaggSteps.filter((s) => stepStates[s.id] === "done").length}/${reaggSteps.length})`}>
                    <ul className="space-y-1 text-xs">
                      {reaggSteps.map((s) => (
                        <li key={s.id} className="flex items-center gap-2 px-1 py-0.5">
                          <StatusDot state={stepStates[s.id] || "queued"} />
                          <span className="truncate flex-1">
                            <span className="text-zinc-500 mr-1">[{s.instance}]</span>{s.domains.length} domain{s.domains.length === 1 ? "" : "s"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Section>
                )}

                {running && (
                  <p className="text-[11px] text-zinc-500">
                    {doneSteps}/{totalSteps} steps complete…
                  </p>
                )}
              </div>
            )}
          </>
        )}

        {recordError && (
          <div className="text-sm text-red-600 dark:text-red-400">Failed to record decision: {recordError}</div>
        )}

        <DialogFooter>
          {!running && !finished && (
            <>
              <Button variant="ghost" onClick={() => onClose(false)}>Cancel</Button>
              <Button
                onClick={start}
                disabled={!plan || loadingPlan || !!planError || plan.steps.length === 0}
                className="bg-amber-600 hover:bg-amber-700 text-white"
              >
                {plan && plan.steps.length === 0
                  ? "Nothing to do"
                  : <><CheckCircle2 className="h-4 w-4 mr-2" /> Start offboarding</>}
              </Button>
            </>
          )}
          {finished && (
            <Button onClick={() => onClose(true)} className="bg-emerald-600 hover:bg-emerald-700 text-white">
              <CheckCircle2 className="h-4 w-4 mr-2" /> Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-xs font-semibold text-zinc-600 dark:text-zinc-300 mb-1.5">{title}</h4>
      {children}
    </div>
  );
}

// ===== Skip dialog =====

function SkipDialog({ item, onClose }: { item: OffboardingItem; onClose: (refresh: boolean) => void }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/churn-offboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientAbbr: item.clientAbbr,
          churnDate: item.churnDate,
          decision: "skip",
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error || `HTTP ${res.status}`);
        return;
      }
      onClose(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !submitting) onClose(false); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Skip offboarding for {item.clientAbbr}?</DialogTitle>
          <DialogDescription>
            Marks this offboarding as skipped permanently. The 9 AM PST auto-fire will NOT run for {item.clientAbbr}. Campaigns stay active, tag stays on inboxes.
          </DialogDescription>
        </DialogHeader>
        {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onClose(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Saving…</> : <><XCircle className="h-4 w-4 mr-2" /> Skip permanently</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
