"use client";

import { useState } from "react";
import { TRIAGE_NEEDS } from "@/lib/constants";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * Shown when a stale client is moved to Complete/Resolved. Captures everything
 * the team wants in the Slack "diagnosed and resolved" notification:
 *   - what the client needs (one of TRIAGE_NEEDS)
 *   - the reason it was flagged for low performance (required)
 *   - what was fixed / any extra detail (optional)
 * This replaces the old standalone "Needs" button on the panel chip — needs is
 * now picked here as part of completing.
 */
export function ResolveTriageDialog({
  clientTag,
  open,
  onOpenChange,
  onConfirm,
}: {
  clientTag: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (result: { needs: string[]; reason: string; fixed: string }) => void;
}) {
  const [need, setNeed] = useState("");
  const [reason, setReason] = useState("");
  const [fixed, setFixed] = useState("");

  function reset() {
    setNeed("");
    setReason("");
    setFixed("");
  }

  function submit() {
    if (!reason.trim()) return;
    onConfirm({
      needs: need ? [need] : [],
      reason: reason.trim(),
      fixed: fixed.trim(),
    });
    reset();
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Complete {clientTag}</DialogTitle>
          <DialogDescription>
            This posts to Slack so the team knows what happened. The reason is required.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">What does this client need?</label>
            <div className="flex flex-col gap-1">
              {TRIAGE_NEEDS.map((option) => (
                <label
                  key={option}
                  className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm cursor-pointer hover:bg-muted/60"
                >
                  <input
                    type="radio"
                    name="triage-need"
                    value={option}
                    checked={need === option}
                    onChange={() => setNeed(option)}
                    className="accent-current"
                  />
                  {option}
                </label>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Reason for low performance</label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Inboxes were disconnected"
              rows={2}
              className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">
              What was fixed / more detail{" "}
              <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <textarea
              value={fixed}
              onChange={(e) => setFixed(e.target.value)}
              placeholder="e.g. Reconnected senders and loaded new leads"
              rows={2}
              className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!reason.trim()}>
            Complete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
