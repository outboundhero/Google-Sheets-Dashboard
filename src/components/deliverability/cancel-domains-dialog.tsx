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

type Phase = "planning" | "review" | "error";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  selectedDomains: string[];
  /** Page takes over: batched apply + top progress panel + Slack + provider check. */
  onStart: (job: CancelJob) => void;
}

const PROVIDER_LABEL: Record<string, string> = { inboxing: "Inboxing", milkbox: "MilkBox", scaledmail: "ScaledMail" };

export function CancelDomainsDialog({ open, onOpenChange, selectedDomains, onStart }: Props) {
  const [phase, setPhase] = useState<Phase>("planning");
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const start = () => {
    if (cancelable.length === 0) return;
    onStart({ domains: cancelable.map((p) => p.domain) });
    onOpenChange(false);
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
            Cancels the selected domains at their provider (Inboxing / MilkBox) —
            deactivation and billing stop on the provider side. The domains{" "}
            <b>stay visible in LeadSync</b>; removing them from the dashboard is the
            separate Delete button. Progress shows in the panel at the top of the page.
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

        <DialogFooter>
          {phase === "review" && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
              <Button
                variant="destructive"
                onClick={start}
                disabled={cancelable.length === 0}
                title={cancelable.length === 0 ? "Nothing cancelable — all selected domains will be skipped" : undefined}
              >
                Cancel {cancelable.length} Domain{cancelable.length !== 1 ? "s" : ""}
              </Button>
            </>
          )}
          {phase === "error" && <Button onClick={() => onOpenChange(false)}>Close</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
