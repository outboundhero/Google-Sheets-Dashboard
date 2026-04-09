"use client";

import { useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedDomains: string[];
  onComplete: () => void;
}

type Phase = "confirm" | "running" | "done";

interface Result {
  inboxes: number;
  campaigns: number;
  removed: number;
  details?: { id: number; name: string; removed: number; error?: string }[];
}

export function RemoveFromCampaignsDialog({ open, onOpenChange, selectedDomains, onComplete }: Props) {
  const [phase, setPhase] = useState<Phase>("confirm");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");

  const handleStart = async () => {
    setPhase("running");
    setError("");
    setResult(null);

    try {
      const res = await fetch("/api/deliverability/remove-from-campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domains: selectedDomains }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResult(data);
      setPhase("done");
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
      setPhase("done");
    }
  };

  const handleClose = () => {
    onOpenChange(false);
    // Reset after animation
    setTimeout(() => { setPhase("confirm"); setResult(null); setError(""); }, 200);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && phase !== "running") handleClose(); }}>
      <DialogContent className="sm:!max-w-lg">
        <DialogHeader>
          <DialogTitle>Remove from Campaigns</DialogTitle>
        </DialogHeader>

        {phase === "confirm" && (
          <div className="space-y-4 mt-2">
            <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-950/20 px-4 py-3">
              <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-amber-200">This will remove all inboxes from their campaigns</p>
                <p className="text-amber-400/80 mt-1 text-xs">
                  {selectedDomains.length} domain{selectedDomains.length !== 1 ? "s" : ""} selected.
                  Active campaigns will be paused during removal, then resumed automatically.
                </p>
              </div>
            </div>

            <div className="max-h-32 overflow-y-auto rounded-lg border divide-y">
              {selectedDomains.map((d) => (
                <div key={d} className="px-3 py-1.5 text-xs text-muted-foreground">{d}</div>
              ))}
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={handleClose}>Cancel</Button>
              <Button size="sm" variant="destructive" onClick={handleStart}>
                Remove from All Campaigns
              </Button>
            </div>
          </div>
        )}

        {phase === "running" && (
          <div className="flex flex-col items-center justify-center py-10 gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Removing inboxes from campaigns...</p>
            <p className="text-xs text-muted-foreground">This may take a few minutes. You can close this dialog — it will continue in the background.</p>
          </div>
        )}

        {phase === "done" && (
          <div className="space-y-4 mt-2">
            {error ? (
              <div className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-950/20 px-4 py-3">
                <XCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
                <div className="text-sm text-red-200">{error}</div>
              </div>
            ) : result && (
              <>
                <div className="flex items-start gap-3 rounded-xl border border-emerald-500/30 bg-emerald-950/20 px-4 py-3">
                  <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
                  <div className="text-sm">
                    <p className="font-medium text-emerald-200">Removal complete</p>
                    <p className="text-emerald-400/80 mt-1 text-xs">
                      Removed {result.removed} inbox{result.removed !== 1 ? "es" : ""} from {result.campaigns} campaign{result.campaigns !== 1 ? "s" : ""}
                    </p>
                  </div>
                </div>

                {result.details && result.details.length > 0 && (
                  <div className="max-h-48 overflow-y-auto rounded-lg border divide-y">
                    {result.details.map((d) => (
                      <div key={d.id} className="flex items-center justify-between px-3 py-2">
                        <span className="text-xs truncate flex-1">{d.name}</span>
                        {d.error ? (
                          <span className="text-[10px] text-destructive shrink-0 ml-2">{d.error}</span>
                        ) : (
                          <span className="text-[10px] text-muted-foreground shrink-0 ml-2">{d.removed} removed</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {result.campaigns === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-2">
                    No campaigns found for the selected domains.
                  </p>
                )}
              </>
            )}

            <div className="flex justify-end">
              <Button size="sm" onClick={handleClose}>Close</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
