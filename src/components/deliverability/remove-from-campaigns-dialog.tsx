"use client";

import { useState, useEffect, useMemo } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Check, CheckCircle2, Loader2, Search, X, XCircle } from "lucide-react";
import { useInstance } from "@/lib/instance-context";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedDomains: string[];
  onComplete: () => void;
}

interface CampaignInfo {
  id: number;
  instance: BisonInstanceSlug;
  name: string;
  status: string;
  inboxCount: number;
}

interface Result {
  inboxes: number;
  campaigns: number;
  removed: number;
  details?: { id: number; name: string; removed: number; error?: string }[];
}

type Phase = "loading" | "select" | "confirm" | "running" | "done";

const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
  paused: "bg-amber-500/10 text-amber-500 border-amber-500/20",
  completed: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  draft: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
};

export function RemoveFromCampaignsDialog({ open, onOpenChange, selectedDomains, onComplete }: Props) {
  const { instancesQuery } = useInstance();
  const [phase, setPhase] = useState<Phase>("loading");
  const [campaigns, setCampaigns] = useState<CampaignInfo[]>([]);
  const [selectedCampaignIds, setSelectedCampaignIds] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");

  // Discover campaigns when dialog opens
  useEffect(() => {
    if (!open || selectedDomains.length === 0) return;
    setPhase("loading");
    setCampaigns([]);
    setSelectedCampaignIds(new Set());
    setSearch("");
    setResult(null);
    setError("");

    fetch(`/api/deliverability/remove-from-campaigns?${instancesQuery}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domains: selectedDomains, discover: true }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.error) { setError(data.error); setPhase("done"); return; }
        const camps = data.campaigns || [];
        setCampaigns(camps);
        setSelectedCampaignIds(new Set(camps.map((c: CampaignInfo) => c.id)));
        setPhase(camps.length === 0 ? "done" : "select");
      })
      .catch((err) => { setError(err.message || "Failed to discover campaigns"); setPhase("done"); });
  }, [open, selectedDomains, instancesQuery]);

  const filtered = useMemo(() => {
    if (!search) return campaigns;
    const q = search.toLowerCase();
    return campaigns.filter((c) => c.name.toLowerCase().includes(q));
  }, [campaigns, search]);

  const selectedCampaigns = useMemo(
    () => campaigns.filter((c) => selectedCampaignIds.has(c.id)),
    [campaigns, selectedCampaignIds]
  );

  const totalInboxesToRemove = useMemo(
    () => selectedCampaigns.reduce((s, c) => s + c.inboxCount, 0),
    [selectedCampaigns]
  );

  const toggleCampaign = (id: number) => {
    setSelectedCampaignIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedCampaignIds.size === filtered.length) {
      setSelectedCampaignIds(new Set());
    } else {
      setSelectedCampaignIds(new Set(filtered.map((c) => c.id)));
    }
  };

  const handleRemove = async () => {
    setPhase("running");
    setError("");
    setResult(null);

    try {
      const res = await fetch(`/api/deliverability/remove-from-campaigns?${instancesQuery}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domains: selectedDomains,
          campaigns: selectedCampaigns.map((c) => ({ id: c.id, instance: c.instance })),
        }),
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
    if (phase === "running") return;
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && phase !== "running") handleClose(); }}>
      <DialogContent className="sm:!max-w-xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Remove from Campaigns</DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">
            {selectedDomains.length} domain{selectedDomains.length !== 1 ? "s" : ""} selected
          </p>
        </DialogHeader>

        {/* Loading */}
        {phase === "loading" && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Finding campaigns for these domains...</p>
          </div>
        )}

        {/* Select campaigns */}
        {phase === "select" && (
          <div className="flex flex-col gap-3 mt-2 flex-1 overflow-hidden">
            <p className="text-sm text-muted-foreground">
              Found {campaigns.length} campaign{campaigns.length !== 1 ? "s" : ""}. Select which to remove inboxes from:
            </p>

            {/* Search */}
            <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-1.5">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search campaigns..."
                className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
              />
              {search && <button onClick={() => setSearch("")}><X className="h-3 w-3 text-muted-foreground hover:text-foreground" /></button>}
            </div>

            {/* Select all */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {selectedCampaignIds.size} of {campaigns.length} selected
              </span>
              <button onClick={toggleAll} className="text-xs text-primary hover:underline">
                {selectedCampaignIds.size === filtered.length ? "Deselect all" : "Select all"}
              </button>
            </div>

            {/* Campaign list */}
            <div className="flex-1 overflow-y-auto rounded-lg border divide-y">
              {filtered.map((c) => {
                const selected = selectedCampaignIds.has(c.id);
                return (
                  <button
                    key={c.id}
                    onClick={() => toggleCampaign(c.id)}
                    className={`flex items-center gap-3 w-full px-3 py-2.5 text-sm transition-colors ${
                      selected ? "bg-primary/5" : "hover:bg-muted/50"
                    }`}
                  >
                    <div className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                      selected ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30"
                    }`}>
                      {selected && <Check className="h-3 w-3" />}
                    </div>
                    <span className="truncate flex-1 text-left">{c.name}</span>
                    <Badge variant="outline" className={`text-[9px] px-1.5 py-0 shrink-0 ${STATUS_COLORS[c.status.toLowerCase()] || ""}`}>
                      {c.status}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">{c.inboxCount} inboxes</span>
                  </button>
                );
              })}
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={handleClose}>Cancel</Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={selectedCampaignIds.size === 0}
                onClick={() => setPhase("confirm")}
              >
                Continue ({selectedCampaignIds.size} campaign{selectedCampaignIds.size !== 1 ? "s" : ""})
              </Button>
            </div>
          </div>
        )}

        {/* Confirm */}
        {phase === "confirm" && (
          <div className="space-y-4 mt-2">
            <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-950/20 px-4 py-3">
              <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-amber-200">Confirm removal</p>
                <p className="text-amber-400/80 mt-1 text-xs">
                  This will remove ~{totalInboxesToRemove} inbox{totalInboxesToRemove !== 1 ? "es" : ""} from {selectedCampaigns.length} campaign{selectedCampaigns.length !== 1 ? "s" : ""}.
                  Active campaigns will be paused during removal, then resumed automatically.
                </p>
              </div>
            </div>

            <div className="max-h-40 overflow-y-auto rounded-lg border divide-y">
              {selectedCampaigns.map((c) => (
                <div key={c.id} className="flex items-center justify-between px-3 py-2">
                  <span className="text-xs truncate flex-1">{c.name}</span>
                  <div className="flex items-center gap-2 shrink-0 ml-2">
                    <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${STATUS_COLORS[c.status.toLowerCase()] || ""}`}>{c.status}</Badge>
                    <span className="text-[10px] text-muted-foreground tabular-nums">{c.inboxCount}</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPhase("select")}>Back</Button>
              <Button size="sm" variant="destructive" onClick={handleRemove}>
                Remove from {selectedCampaigns.length} Campaign{selectedCampaigns.length !== 1 ? "s" : ""}
              </Button>
            </div>
          </div>
        )}

        {/* Running */}
        {phase === "running" && (
          <div className="flex flex-col items-center justify-center py-10 gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Removing inboxes from campaigns...</p>
            <p className="text-xs text-muted-foreground">Pausing active campaigns, removing inboxes, then resuming.</p>
            <p className="text-xs text-muted-foreground/60">You can close this dialog — it will continue in the background.</p>
          </div>
        )}

        {/* Done */}
        {phase === "done" && (
          <div className="space-y-4 mt-2">
            {error ? (
              <div className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-950/20 px-4 py-3">
                <XCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
                <div className="text-sm text-red-200">{error}</div>
              </div>
            ) : result ? (
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
              </>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-4">
                No campaigns found for the selected domains.
              </p>
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
