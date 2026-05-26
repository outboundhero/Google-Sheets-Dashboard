"use client";

/**
 * Bulk change-redirect dialog.
 *
 * Step 1 — opens, runs a dry-run against /api/deliverability/change-redirect to
 *   route each selected domain to its provider (MilkBox / Inboxing / ScaledMail)
 *   based on its tags. Domains tagged Cheap Inboxes (no API), or missing a
 *   vendor tag, or without a provider_domain_id in LeadSync, are surfaced
 *   as "will skip" with the reason.
 * Step 2 — user types one new redirect URL → click Apply.
 * Step 3 — apply phase calls the same route with the URL; per-row results
 *   stream in (updated / skipped / failed with retry-exhausted reason).
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
import { Input } from "@/components/ui/input";
import {
  AlertTriangle,
  CheckCircle2,
  Link2,
  Loader2,
  XCircle,
} from "lucide-react";

type ProviderSlug = "milkbox" | "scaledmail" | "inboxing";

interface DomainRouting {
  domain: string;
  tags: string[];
  provider: ProviderSlug | null;
  providerDomainId: string | null;
  skipReason: string | null;
}

interface PlanResponse {
  dryRun: true;
  routing: DomainRouting[];
  counts: {
    total: number;
    byProvider: Record<ProviderSlug, number>;
    skipped: number;
  };
}

interface PerDomainResult {
  domain: string;
  provider: ProviderSlug | null;
  status: "updated" | "skipped" | "failed";
  reason?: string;
  attempts?: number;
}

interface ApplyResponse {
  dryRun: false;
  newUrl: string;
  results: PerDomainResult[];
  summary: { updated: number; skipped: number; failed: number };
}

type Phase = "planning" | "review" | "applying" | "done" | "error";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  selectedDomains: string[];
  onComplete: () => void;
}

const PROVIDER_LABEL: Record<ProviderSlug, string> = {
  milkbox: "MilkBox",
  scaledmail: "ScaledMail",
  inboxing: "Inboxing",
};

export function ChangeRedirectDialog({
  open,
  onOpenChange,
  selectedDomains,
  onComplete,
}: Props) {
  const [phase, setPhase] = useState<Phase>("planning");
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [result, setResult] = useState<ApplyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newUrl, setNewUrl] = useState("");

  // Plan once when dialog opens
  useEffect(() => {
    if (!open) {
      // reset on close
      setPlan(null);
      setResult(null);
      setError(null);
      setNewUrl("");
      setPhase("planning");
      return;
    }
    if (selectedDomains.length === 0) return;
    setPhase("planning");
    setError(null);
    setPlan(null);
    setResult(null);
    fetch("/api/deliverability/change-redirect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true, domains: selectedDomains }),
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setPlan(data as PlanResponse);
        setPhase("review");
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Failed");
        setPhase("error");
      });
  }, [open, selectedDomains]);

  const urlValid = useMemo(() => /^https?:\/\/.+/i.test(newUrl.trim()), [newUrl]);

  const actionableCount = useMemo(
    () => plan?.routing.filter((r) => !r.skipReason && r.provider).length ?? 0,
    [plan],
  );

  const apply = async () => {
    if (!urlValid) return;
    setPhase("applying");
    setError(null);
    try {
      const res = await fetch("/api/deliverability/change-redirect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dryRun: false,
          domains: selectedDomains,
          newUrl: newUrl.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResult(data as ApplyResponse);
      setPhase("done");
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
      setPhase("error");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => phase !== "applying" && onOpenChange(v)}>
      <DialogContent className="sm:!max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-4 w-4" />
            Change Redirect
          </DialogTitle>
          <DialogDescription>
            Bulk-update the redirect URL on the selected domains. Each domain
            is routed to its provider (MilkBox / Inboxing / ScaledMail) based
            on its tags. Cheap Inboxes and unrecognised domains are skipped.
          </DialogDescription>
        </DialogHeader>

        {phase === "planning" && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              Routing {selectedDomains.length} domain{selectedDomains.length !== 1 ? "s" : ""}…
            </span>
          </div>
        )}

        {phase === "review" && plan && (
          <div className="flex flex-col gap-3 flex-1 overflow-hidden">
            {/* Per-provider summary */}
            <div className="flex flex-wrap gap-2">
              {(["milkbox", "inboxing", "scaledmail"] as ProviderSlug[]).map((p) => {
                const n = plan.counts.byProvider[p];
                if (!n) return null;
                return (
                  <Badge key={p} variant="outline" className="text-xs">
                    {n} via {PROVIDER_LABEL[p]}
                  </Badge>
                );
              })}
              {plan.counts.skipped > 0 && (
                <Badge variant="outline" className="text-xs text-amber-500 border-amber-500/40">
                  {plan.counts.skipped} will skip
                </Badge>
              )}
            </div>

            {/* New URL input */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium">New redirect URL</label>
              <Input
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder="https://example.com"
                autoComplete="off"
              />
              {newUrl && !urlValid && (
                <p className="text-xs text-red-400">Must start with http:// or https://</p>
              )}
            </div>

            {/* Per-domain preview */}
            <div className="flex-1 overflow-y-auto rounded-md border min-h-[140px]">
              <table className="w-full text-xs">
                <thead className="text-left bg-muted/50 sticky top-0">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">Domain</th>
                    <th className="px-2 py-1.5 font-medium">Routing</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {plan.routing.map((r) => (
                    <tr key={r.domain} className={r.skipReason ? "bg-amber-950/10" : ""}>
                      <td className="px-2 py-1 truncate max-w-[260px]">{r.domain}</td>
                      <td className="px-2 py-1">
                        {r.skipReason ? (
                          <span className="text-amber-400 inline-flex items-center gap-1">
                            <AlertTriangle className="h-3 w-3" />
                            Skip — {r.skipReason}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">
                            via <span className="text-foreground font-medium">{PROVIDER_LABEL[r.provider!]}</span>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {phase === "applying" && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <p className="text-sm">Updating redirects…</p>
            <p className="text-xs text-muted-foreground">Up to 3 retries per domain on failure.</p>
          </div>
        )}

        {phase === "done" && result && (
          <div className="flex flex-col gap-3 flex-1 overflow-hidden">
            <div className="flex items-start gap-3 rounded-md border border-emerald-500/30 bg-emerald-950/20 px-3 py-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
              <div className="text-sm">
                <p className="font-medium text-emerald-200">Change complete</p>
                <p className="text-emerald-400/80 text-xs mt-0.5">
                  {result.summary.updated} updated · {result.summary.skipped} skipped
                  {result.summary.failed > 0 ? ` · ${result.summary.failed} failed` : ""}
                </p>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="text-left bg-muted/50 sticky top-0">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">Domain</th>
                    <th className="px-2 py-1.5 font-medium">Provider</th>
                    <th className="px-2 py-1.5 font-medium">Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {result.results.map((r) => (
                    <tr key={r.domain}>
                      <td className="px-2 py-1 truncate max-w-[220px]">{r.domain}</td>
                      <td className="px-2 py-1 text-muted-foreground">
                        {r.provider ? PROVIDER_LABEL[r.provider] : "—"}
                      </td>
                      <td className="px-2 py-1">
                        {r.status === "updated" && (
                          <span className="text-emerald-400 inline-flex items-center gap-1">
                            <CheckCircle2 className="h-3 w-3" />
                            updated
                            {r.attempts && r.attempts > 1 ? ` (${r.attempts} tries)` : ""}
                          </span>
                        )}
                        {r.status === "skipped" && (
                          <span className="text-amber-400 inline-flex items-center gap-1" title={r.reason}>
                            <AlertTriangle className="h-3 w-3" />
                            skipped — {r.reason}
                          </span>
                        )}
                        {r.status === "failed" && (
                          <span className="text-red-400 inline-flex items-center gap-1" title={r.reason}>
                            <XCircle className="h-3 w-3" />
                            <span className="truncate max-w-[280px]">failed — {r.reason}</span>
                          </span>
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
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button
                onClick={apply}
                disabled={!urlValid || actionableCount === 0}
                title={actionableCount === 0 ? "Nothing routable — all selected domains will be skipped" : undefined}
              >
                Apply to {actionableCount} domain{actionableCount !== 1 ? "s" : ""}
              </Button>
            </>
          )}
          {(phase === "done" || phase === "error") && (
            <Button onClick={() => onOpenChange(false)}>Close</Button>
          )}
          {phase === "applying" && (
            <Button disabled>
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              Applying…
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
