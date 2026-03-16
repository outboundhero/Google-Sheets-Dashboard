"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, XCircle, Loader2, Link2, AlertTriangle } from "lucide-react";

interface CampaignPreview {
  campaign_id: number;
  campaign_name: string;
  client_tag: string;
  matching_count: number;
  campaign_status: string;
}

interface AttachResult {
  campaign_id: number;
  campaign_name: string;
  total_matched: number;
  already_attached: number;
  newly_attached: number;
  error?: string;
}

type Phase = "loading" | "preview" | "attaching" | "done";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AttachCampaignsDialog({ open, onOpenChange }: Props) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [campaigns, setCampaigns] = useState<CampaignPreview[]>([]);
  const [results, setResults] = useState<AttachResult[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const loadPreview = useCallback(async () => {
    setPhase("loading");
    setError(null);
    setResults([]);
    setCurrentIndex(0);
    try {
      const res = await fetch("/api/deliverability/attach-campaigns");
      if (!res.ok) throw new Error("Failed to load campaigns");
      const data: CampaignPreview[] = await res.json();
      setCampaigns(data.filter((c) => c.matching_count > 0));
      setPhase("preview");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setPhase("preview");
    }
  }, []);

  useEffect(() => {
    if (open) loadPreview();
  }, [open, loadPreview]);

  const handleAttachAll = async () => {
    setPhase("attaching");
    setResults([]);
    setCurrentIndex(0);

    for (let i = 0; i < campaigns.length; i++) {
      setCurrentIndex(i);
      const c = campaigns[i];
      try {
        const res = await fetch("/api/deliverability/attach-campaigns", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            campaign_id: c.campaign_id,
            campaign_name: c.campaign_name,
            client_tag: c.client_tag,
          }),
        });
        const result = await res.json();
        if (!res.ok) {
          setResults((prev) => [
            ...prev,
            {
              campaign_id: c.campaign_id,
              campaign_name: c.campaign_name,
              total_matched: c.matching_count,
              already_attached: 0,
              newly_attached: 0,
              error: result.error || "Failed",
            },
          ]);
        } else {
          setResults((prev) => [...prev, result]);
        }
      } catch {
        setResults((prev) => [
          ...prev,
          {
            campaign_id: c.campaign_id,
            campaign_name: c.campaign_name,
            total_matched: c.matching_count,
            already_attached: 0,
            newly_attached: 0,
            error: "Network error",
          },
        ]);
      }
    }
    setPhase("done");
  };

  const totalNewlyAttached = results.reduce((s, r) => s + r.newly_attached, 0);
  const totalAlreadyAttached = results.reduce((s, r) => s + r.already_attached, 0);
  const totalErrors = results.filter((r) => r.error).length;

  const statusBadge = (status: string) => {
    const s = status.toLowerCase();
    if (s === "active") return <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px]">Active</Badge>;
    if (s === "paused") return <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30 text-[10px]">Paused</Badge>;
    if (s === "draft") return <Badge className="bg-blue-500/15 text-blue-400 border-blue-500/30 text-[10px]">Draft</Badge>;
    return <Badge variant="outline" className="text-[10px]">{status}</Badge>;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-5 w-5" />
            Attach Inboxes to Campaigns
          </DialogTitle>
        </DialogHeader>

        {/* Loading */}
        {phase === "loading" && (
          <div className="space-y-3 py-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading campaigns and matching inboxes…
            </div>
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-10 rounded-lg" />
            ))}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {/* Preview */}
        {phase === "preview" && !error && (
          <>
            <p className="text-sm text-muted-foreground">
              Found {campaigns.length} campaign{campaigns.length !== 1 ? "s" : ""} with matching inboxes.
              Inboxes already attached will be skipped.
            </p>

            <div className="flex-1 overflow-y-auto -mx-6 px-6">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground text-left">
                    <th className="py-2 font-medium">Campaign</th>
                    <th className="py-2 font-medium text-center w-20">Tag</th>
                    <th className="py-2 font-medium text-center w-20">Inboxes</th>
                    <th className="py-2 font-medium text-center w-20">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => (
                    <tr key={c.campaign_id} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                      <td className="py-2.5 pr-2 truncate max-w-[280px]">{c.campaign_name}</td>
                      <td className="py-2.5 text-center">
                        <span className="inline-flex text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                          {c.client_tag}
                        </span>
                      </td>
                      <td className="py-2.5 text-center font-medium">{c.matching_count}</td>
                      <td className="py-2.5 text-center">{statusBadge(c.campaign_status)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between pt-3 border-t">
              <span className="text-xs text-muted-foreground">
                {campaigns.reduce((s, c) => s + c.matching_count, 0).toLocaleString()} total inbox matches
              </span>
              <Button onClick={handleAttachAll} disabled={campaigns.length === 0} className="gap-2">
                <Link2 className="h-4 w-4" />
                Attach All
              </Button>
            </div>
          </>
        )}

        {/* Attaching — Progress */}
        {(phase === "attaching" || phase === "done") && (
          <>
            {/* Progress bar */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {phase === "attaching"
                    ? `Processing campaign ${currentIndex + 1} of ${campaigns.length}…`
                    : "Complete"}
                </span>
                <span className="font-medium">
                  {results.length}/{campaigns.length}
                </span>
              </div>
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    phase === "done" ? "bg-emerald-500" : "bg-primary"
                  }`}
                  style={{ width: `${(results.length / Math.max(campaigns.length, 1)) * 100}%` }}
                />
              </div>
            </div>

            {/* Running totals */}
            <div className="flex gap-4 text-sm">
              <div className="flex items-center gap-1.5">
                <div className="h-2 w-2 rounded-full bg-emerald-500" />
                <span className="text-muted-foreground">Attached:</span>
                <span className="font-medium">{totalNewlyAttached.toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="h-2 w-2 rounded-full bg-muted-foreground" />
                <span className="text-muted-foreground">Already present:</span>
                <span className="font-medium">{totalAlreadyAttached.toLocaleString()}</span>
              </div>
              {totalErrors > 0 && (
                <div className="flex items-center gap-1.5">
                  <div className="h-2 w-2 rounded-full bg-destructive" />
                  <span className="text-muted-foreground">Errors:</span>
                  <span className="font-medium text-destructive">{totalErrors}</span>
                </div>
              )}
            </div>

            {/* Per-campaign results */}
            <div className="flex-1 overflow-y-auto -mx-6 px-6 space-y-1">
              {results.map((r) => (
                <div
                  key={r.campaign_id}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm ${
                    r.error
                      ? "bg-destructive/5 border border-destructive/20"
                      : "bg-muted/30"
                  }`}
                >
                  {r.error ? (
                    <XCircle className="h-4 w-4 text-destructive shrink-0" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                  )}
                  <span className="truncate flex-1">{r.campaign_name}</span>
                  {r.error ? (
                    <span className="text-xs text-destructive shrink-0">{r.error}</span>
                  ) : (
                    <span className="text-xs text-muted-foreground shrink-0">
                      {r.newly_attached > 0 && (
                        <span className="text-emerald-400 font-medium">{r.newly_attached} attached</span>
                      )}
                      {r.newly_attached > 0 && r.already_attached > 0 && " · "}
                      {r.already_attached > 0 && `${r.already_attached} already present`}
                      {r.newly_attached === 0 && r.already_attached === 0 && "No matches"}
                    </span>
                  )}
                </div>
              ))}
              {/* Current processing indicator */}
              {phase === "attaching" && currentIndex < campaigns.length && (
                <div className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm bg-primary/5 border border-primary/20">
                  <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
                  <span className="truncate flex-1">{campaigns[currentIndex]?.campaign_name}</span>
                  <span className="text-xs text-muted-foreground">Processing…</span>
                </div>
              )}
            </div>

            {/* Done footer */}
            {phase === "done" && (
              <div className="flex items-center justify-between pt-3 border-t">
                <span className="text-sm text-muted-foreground">
                  {totalNewlyAttached.toLocaleString()} inboxes attached across {results.filter((r) => r.newly_attached > 0).length} campaigns
                </span>
                <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                  Close
                </Button>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
