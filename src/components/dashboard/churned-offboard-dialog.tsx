"use client";

// Confirmation dialog that opens from the Churned clients list's per-row
// Offboard button. Fetches the offboarding plan (so we can show real inbox
// and active-campaign counts), then on confirm hands the plan up to the
// page-level state — the actual progress renders in the top-mounted
// OffboardingProgressCard, NOT in this dialog.
import { useEffect, useState } from "react";
import { Loader2, AlertTriangle, CheckCircle2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { OffboardingPlan } from "@/components/dashboard/offboarding-progress-card";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientAbbr: string;
  companyName: string;
  churnDate: string;
  onStart: (plan: OffboardingPlan) => void;
}

export function ChurnedOffboardDialog({
  open, onOpenChange, clientAbbr, companyName, churnDate, onStart,
}: Props) {
  // Parent conditionally renders this component, so mount==open. Fresh state
  // every time.
  const [plan, setPlan] = useState<OffboardingPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/churn-offboarding/plan?clientAbbr=${encodeURIComponent(clientAbbr)}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.error) setError(j.error);
        else setPlan(j as OffboardingPlan);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "plan failed"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [clientAbbr]);

  const activeCampaigns = plan?.summary.campaigns ?? 0;   // plan only enumerates active-non-paused campaigns
  const inboxes = plan?.summary.inboxes ?? 0;
  const domains = plan?.summary.domains ?? 0;
  const nothingToDo = plan && plan.steps.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Offboard {companyName}?
          </DialogTitle>
          <DialogDescription>
            Are you sure you want to offboard <strong>{clientAbbr}</strong>? This will pause every
            active campaign for the tag and detach the tag from every sender inbox carrying it.
            The tag itself stays alive in Bison.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 text-sm text-zinc-500 py-6">
            <Loader2 className="h-4 w-4 animate-spin" /> Planning the offboarding…
          </div>
        )}

        {error && (
          <div className="text-sm text-red-600 dark:text-red-400 py-2">{error}</div>
        )}

        {plan && !loading && (
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 text-sm space-y-1.5">
            <div className="flex justify-between">
              <span className="text-zinc-500">Active campaigns to pause</span>
              <span className="font-medium">{activeCampaigns.toLocaleString("en-US")}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Inboxes to detag</span>
              <span className="font-medium">{inboxes.toLocaleString("en-US")}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Affected domains</span>
              <span className="font-medium">{domains.toLocaleString("en-US")}</span>
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
            <div className="flex justify-between text-[11px] pt-1 border-t border-zinc-200 dark:border-zinc-800 mt-1.5">
              <span className="text-zinc-500">Churn date</span>
              <span className="text-zinc-500">{churnDate}</span>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={() => {
              if (!plan) return;
              onStart(plan);
              onOpenChange(false);
            }}
            disabled={!plan || loading || !!error || nothingToDo === true}
            className="bg-amber-600 hover:bg-amber-700 text-white"
          >
            {nothingToDo
              ? "Nothing to do"
              : <><CheckCircle2 className="h-4 w-4 mr-2" /> Offboard now</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
