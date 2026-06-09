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
 * Shown when a stale client is moved to Complete/Resolved. Captures what goes
 * into the Slack "diagnosed and resolved" notification:
 *   - what the client needs (one of TRIAGE_NEEDS)
 *   - any extra detail (optional, free text)
 * Nothing is required — Complete is always clickable. Replaces the old
 * standalone "Needs" button; needs is now picked here as part of completing.
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
  onConfirm: (result: { needs: string[]; detail: string }) => void;
}) {
  const [need, setNeed] = useState("");
  const [detail, setDetail] = useState("");

  function reset() {
    setNeed("");
    setDetail("");
  }

  function submit() {
    onConfirm({
      needs: need ? [need] : [],
      detail: detail.trim(),
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
            This posts to Slack so the team knows what happened.
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
            <label className="text-sm font-medium">
              More detail{" "}
              <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <textarea
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              placeholder="e.g. Inboxes were disconnected — reconnected senders and loaded new leads"
              rows={3}
              className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit}>Complete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
