"use client";

// Replacement execution CONFIRM dialog. Shows exactly what will happen for one
// client and, on confirm, hands the inputs to the page-level execution queue
// (it does NOT run anything itself). Confirm-first per client.
import { ShieldAlert } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { ExecuteInputs } from "@/lib/replacement/execute-runner";

export type { ExecuteInputs };

export function ExecuteDialog({
  open, onOpenChange, inputs, onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  inputs: ExecuteInputs;
  onConfirm: (inputs: ExecuteInputs) => void;
}) {
  const { clientTag, instance, redirectUrl, targetCampaigns, replacementDomains, removeDomains } = inputs;
  const nothing = replacementDomains.length === 0 && removeDomains.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Execute replacement — {clientTag} <span className="text-muted-foreground font-normal">({instance})</span></DialogTitle>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-amber-600 dark:text-amber-400">
            <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
            <span>This performs <b>real</b> actions for {clientTag}. Burnt domains are removed from campaigns (reversible) and scheduled for vendor-delete in <b>5 days</b> — nothing is deleted at the provider now.</span>
          </div>
          <ul className="space-y-1.5 text-muted-foreground">
            <li>➕ Add <b className="text-emerald-500">{replacementDomains.length}</b> replacement domain(s) → tag, set redirect{redirectUrl ? ` (${redirectUrl.replace(/^https?:\/\//, "")})` : ""}, attach to <b>{targetCampaigns.length}</b> campaign(s), sheet + whitelist.</li>
            <li>➖ Remove <b className="text-amber-500">{removeDomains.length}</b> burnt domain(s) from campaigns + schedule cancellation (+5d).</li>
          </ul>
          {nothing && <p className="text-destructive">Nothing to execute for this client.</p>}
          <p className="text-[11px] text-muted-foreground">Added to the execution queue — runs after any client(s) ahead of it. You can queue more while it runs.</p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => { onConfirm(inputs); onOpenChange(false); }} disabled={nothing}>Add to queue</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
