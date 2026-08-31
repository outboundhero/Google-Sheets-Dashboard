"use client";

/**
 * Bulk cancel-at-provider dialog (Inboxing + MilkBox).
 *
 * Step 1 — on open, dry-runs /api/deliverability/cancel-domains: routes each
 *   selected domain to its provider by tag. ScaledMail domains are surfaced
 *   with an explicit "this workflow is for Inboxing and MilkBox domains"
 *   message (ScaledMail has no per-domain cancel API).
 * Step 2 — "Cancel N Domains" hands the job off to the page, which drives the
 *   batched apply with live progress in the top panel, sends the Slack
 *   summary, and auto-runs Check Provider Status at the end.
 *
 * Canceling deactivates the domain AT THE PROVIDER — the rows stay visible
 * in LeadSync (removal from the dashboard is the separate Delete button).
 */
import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Ban, Loader2, XCircle } from "lucide-react";

interface PlanRow {
  domain: string;
  provider: "inboxing" | "milkbox" | "scaledmail" | null;
  providerDomainId: string | null;
  skipReason: string | null;
}

interface PlanResponse {
  plan: PlanRow[];
  counts: { cancelable: number; skipped: number; byProvider: { inboxing: number; milkbox: number } };
}

export interface CancelJob {
  domains: string[];
}

type Phase = "planning" | "review" | "running" | "done" | "error";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  selectedDomains: string[];
  /** @deprecated staged flow is server-orchestrated now; kept for call-site compat. */
  onStart?: (job: CancelJob) => void;
}

const PROVIDER_LABEL: Record<string, string> = { inboxing: "Inboxing", milkbox: "MilkBox", scaledmail: "ScaledMail" };

export function CancelDomainsDialog({ open, onOpenChange, selectedDomains }: Props) {
  const [phase, setPhase] = useState<Phase>("planning");
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [doneMsg, setDoneMsg] = useState<string>("");
  const [progress, setProgress] = useState<string>("");

  // Snapshot the selection on the open transition only.
  useEffect(() => {
    if (!open) {
      setPlan(null);
      setError(null);
      setPhase("planning");
      return;
    }
    if (selectedDomains.length === 0) return;
    setPhase("planning");
    fetch("/api/deliverability/cancel-domains", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true, domains: selectedDomains }),
    })
      .then(async (res) => {
        const text = await res.text();
        let data: PlanResponse & { error?: string };
        try { data = JSON.parse(text); } catch { throw new Error(`non-JSON response (HTTP ${res.status})`); }
        if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
        setPlan(data);
        setPhase("review");
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Failed");
        setPhase("error");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const cancelable = useMemo(() => (plan?.plan || []).filter((p) => !p.skipReason), [plan]);
  const scaledmailCount = useMemo(
    () => (plan?.plan || []).filter((p) => p.provider === "scaledmail").length,
    [plan],
  );

  // Staged wind-down (Spencer 2026-07-29): both modes first throttle to 1/day +
  // remove from all campaigns; then cancel now (→ delete senders ~10 min later)
  // or cancel in 3 days (→ then delete). Server-orchestrated via one endpoint.
  // One server call per BATCH, not per selection: a 384-domain selection in a
  // single request times out at Vercel's 5-minute cap (Spencer's 504,
  // 2026-08-29 — the throttle + remove-from-campaigns work alone exceeds it).
  // Batches are sequential so provider/Bison rate limits see the same pacing
  // as before; a failed batch is retried once, then reported, and the batches
  // already processed stay done (safe — the endpoint is idempotent per domain).
  const BATCH = 15;
  const run = async (mode: "immediate" | "delayed") => {
    if (cancelable.length === 0) return;
    setPhase("running");
    setError(null);
    const all = cancelable.map((p) => p.domain);
    let done = 0;
    const failedBatches: string[] = [];
    for (let i = 0; i < all.length; i += BATCH) {
      const batch = all.slice(i, i + BATCH);
      let ok = false;
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        try {
          const res = await fetch("/api/deliverability/schedule-cancellation", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ domains: batch, mode }),
          });
          const text = await res.text();
          let data: { ok?: boolean; error?: string };
          try { data = JSON.parse(text); } catch { throw new Error(`non-JSON response (HTTP ${res.status})`); }
          if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
          ok = true;
        } catch (e) {
          if (attempt === 1) failedBatches.push(`${batch[0]}…+${batch.length - 1}: ${e instanceof Error ? e.message : "failed"}`);
          else await new Promise((r) => setTimeout(r, 3000));
        }
      }
      if (ok) done += batch.length;
      setProgress(`${Math.min(i + BATCH, all.length)}/${all.length} processed…`);
    }
    if (done === 0) {
      setError(`all batches failed — ${failedBatches[0] || "see console"}`);
      setPhase("error");
      return;
    }
    const failNote = failedBatches.length > 0 ? ` ${all.length - done} failed (re-run the dialog for just those).` : "";
    setDoneMsg(
      mode === "immediate"
        ? `Throttled to 1/day, removed from campaigns, and cancelled ${done} domain(s) at the vendor.${failNote} Sender accounts delete from Bison in ~10 min.`
        : `Throttled to 1/day and removed ${done} domain(s) from campaigns.${failNote} The vendor cancel (then Bison sender delete) fires automatically in 3 days.`,
    );
    setPhase("done");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:!max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ban className="h-4 w-4 text-destructive" />
            Cancel Domains
          </DialogTitle>
          <DialogDescription>
            Staged wind-down. Both options first <b>throttle to 1/day</b> and{" "}
            <b>remove from all campaigns</b> right away. Then either cancel now
            (Bison sender accounts delete ~10 min later) or cancel in 3 days (a
            buffer, then the vendor cancel + Bison sender delete fire automatically).
            Inboxing / MilkBox only — ScaledMail is skipped.
          </DialogDescription>
        </DialogHeader>

        {phase === "planning" && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              Routing {selectedDomains.length} domain{selectedDomains.length !== 1 ? "s" : ""} to their providers…
            </span>
          </div>
        )}

        {phase === "review" && plan && (
          <div className="flex flex-col gap-3 flex-1 overflow-hidden">
            <div className="flex flex-wrap gap-2">
              {plan.counts.byProvider.inboxing > 0 && (
                <Badge variant="outline" className="text-xs">{plan.counts.byProvider.inboxing} via Inboxing</Badge>
              )}
              {plan.counts.byProvider.milkbox > 0 && (
                <Badge variant="outline" className="text-xs">{plan.counts.byProvider.milkbox} via MilkBox</Badge>
              )}
              {plan.counts.skipped > 0 && (
                <Badge variant="outline" className="text-xs text-amber-500 border-amber-500/40">
                  {plan.counts.skipped} will skip
                </Badge>
              )}
            </div>

            {scaledmailCount > 0 && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-950/10 px-3 py-2 text-xs text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                {scaledmailCount} ScaledMail domain{scaledmailCount !== 1 ? "s" : ""} will be skipped — this
                workflow is for Inboxing and MilkBox domains only (ScaledMail has no per-domain cancel API).
              </div>
            )}

            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-destructive" />
              <span>
                This starts deactivation at the provider and usually cannot be undone.
                A Slack summary of the successfully canceled domains is posted when the run finishes,
                and the Provider column is re-verified live afterwards.
              </span>
            </div>

            <div className="flex-1 overflow-y-auto rounded-md border min-h-[140px]">
              <table className="w-full text-xs">
                <thead className="text-left bg-muted/50 sticky top-0">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">Domain</th>
                    <th className="px-2 py-1.5 font-medium">Provider</th>
                    <th className="px-2 py-1.5 font-medium">Plan</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {(plan.plan || []).map((r) => (
                    <tr key={r.domain} className={r.skipReason ? "bg-amber-950/10" : ""}>
                      <td className="px-2 py-1 truncate max-w-[220px]">{r.domain}</td>
                      <td className="px-2 py-1 text-muted-foreground">
                        {r.provider ? PROVIDER_LABEL[r.provider] ?? r.provider : "—"}
                      </td>
                      <td className="px-2 py-1">
                        {r.skipReason ? (
                          <span className="text-amber-400 inline-flex items-center gap-1">
                            <AlertTriangle className="h-3 w-3" />
                            Skip — {r.skipReason}
                          </span>
                        ) : (
                          <span className="text-destructive/90">cancel at {PROVIDER_LABEL[r.provider!] ?? r.provider}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {phase === "error" && (
          <div className="flex items-start gap-3 rounded-md border border-red-500/30 bg-red-950/20 px-3 py-2">
            <XCircle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
            <div className="text-sm text-red-200">{error}</div>
          </div>
        )}

        {phase === "running" && (
          <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Throttling, removing from campaigns… {progress}
          </div>
        )}
        {phase === "done" && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-500">{doneMsg}</div>
        )}

        <DialogFooter>
          {phase === "review" && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
              <Button
                variant="outline"
                onClick={() => run("delayed")}
                disabled={cancelable.length === 0}
                title={cancelable.length === 0 ? "Nothing cancelable — all selected domains will be skipped" : "Throttle + remove now; vendor cancel in 3 days"}
              >
                Cancel in 3 days ({cancelable.length})
              </Button>
              <Button
                variant="destructive"
                onClick={() => run("immediate")}
                disabled={cancelable.length === 0}
                title={cancelable.length === 0 ? "Nothing cancelable — all selected domains will be skipped" : undefined}
              >
                Cancel now ({cancelable.length})
              </Button>
            </>
          )}
          {(phase === "done" || phase === "error") && <Button onClick={() => onOpenChange(false)}>Close</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
