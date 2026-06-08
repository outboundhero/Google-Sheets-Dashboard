"use client";

import { useState } from "react";
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
 * Captures the diagnosis when a stale client is marked Resolved: the reason it
 * was flagged for low performance and what was fixed. Both flow into the Slack
 * "diagnosed and resolved" notification (see /api/triage-status). Reason is
 * required (Spencer's "at least the reason"); what-was-fixed is optional.
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
  onConfirm: (diagnosis: { reason: string; fixed: string }) => void;
}) {
  const [reason, setReason] = useState("");
  const [fixed, setFixed] = useState("");

  function reset() {
    setReason("");
    setFixed("");
  }

  function submit() {
    if (!reason.trim()) return;
    onConfirm({ reason: reason.trim(), fixed: fixed.trim() });
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
          <DialogTitle>Resolve {clientTag}</DialogTitle>
          <DialogDescription>
            This posts to Slack so the team knows what happened. The reason is required.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-sm font-medium">Reason for low performance</label>
            <textarea
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Inboxes were disconnected"
              rows={2}
              className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">
              What was fixed <span className="text-muted-foreground font-normal">(optional)</span>
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
            Resolve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
