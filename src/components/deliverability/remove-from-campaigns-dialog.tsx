"use client";

import { useState, useEffect, useMemo } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Check, CheckCircle2, Loader2, Plus, Search, X, XCircle } from "lucide-react";
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
  inboxCount: number; // 0 for manually-added (unknown until removal)
  // From discovery: the exact inbox IDs Bison says are attached to this
  // campaign from the user's selected domains. Sent back on removal so the
  // server skips a slow re-fetch that's prone to silent truncation.
  inboxIds?: number[];
  source: "auto" | "manual";
}

interface AllCampaign {
  id: number;
  instance: BisonInstanceSlug;
  name: string;
  status: string;
}

interface Result {
  inboxes: number;
  campaigns: number;
  removed: number;
  details?: { id: number; name: string; removed: number; error?: string }[];
}

type Phase = "select" | "confirm" | "running" | "done";

const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
  paused: "bg-amber-500/10 text-amber-500 border-amber-500/20",
  completed: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  draft: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
};

// Calls a route and parses JSON, retrying on transient errors. Catches the
// "Unexpected token 'A', 'An error o'..." case where Vercel returns its HTML
// error page on a cold start or function failure — surfaces a real message
// instead of throwing a JSON.parse stack trace.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchJsonWithRetry(url: string, init: RequestInit): Promise<any> {
  const attempts = 3;
  let lastErr = "request failed";
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        if (!res.ok && !json.error) json.error = `HTTP ${res.status}`;
        return json;
      } catch {
        lastErr = res.status >= 500
          ? `Server returned a non-JSON error (HTTP ${res.status}). This usually means a transient timeout — please try again.`
          : `Unexpected non-JSON response (HTTP ${res.status})`;
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : "network error";
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
  }
  throw new Error(lastErr);
}

export function RemoveFromCampaignsDialog({ open, onOpenChange, selectedDomains, onComplete }: Props) {
  const { instancesQuery } = useInstance();
  const [phase, setPhase] = useState<Phase>("select");
  const [autoCampaigns, setAutoCampaigns] = useState<CampaignInfo[]>([]);
  const [manualCampaigns, setManualCampaigns] = useState<CampaignInfo[]>([]);
  const [allCampaigns, setAllCampaigns] = useState<AllCampaign[]>([]);
  const [selectedCampaignIds, setSelectedCampaignIds] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [allLoading, setAllLoading] = useState(false);
  // Live progress for the chunked (one-request-per-campaign) removal.
  interface RemoveDetail { id: number; name: string; removed: number; error?: string }
  const [removeProgress, setRemoveProgress] = useState<{ total: number; done: number; current: string | null; details: RemoveDetail[] } | null>(null);

  // On open: kick off auto-discovery + full campaign list in background — the user
  // can interact with the search bar immediately while these load.
  useEffect(() => {
    if (!open || selectedDomains.length === 0) return;
    setPhase("select");
    setAutoCampaigns([]);
    setManualCampaigns([]);
    setAllCampaigns([]);
    setSelectedCampaignIds(new Set());
    setSearch("");
    setResult(null);
    setError("");
    setRemoveProgress(null);

    setDiscovering(true);
    fetchJsonWithRetry(`/api/deliverability/remove-from-campaigns?${instancesQuery}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domains: selectedDomains, discover: true }),
    })
      .then((data) => {
        if (data.error) throw new Error(data.error);
        const camps: CampaignInfo[] = (data.campaigns || []).map(
          (c: Omit<CampaignInfo, "source">) => ({ ...c, source: "auto" as const })
        );
        setAutoCampaigns(camps);
        setSelectedCampaignIds((prev) => {
          const next = new Set(prev);
          for (const c of camps) next.add(c.id);
          return next;
        });
      })
      .catch((err) => { setError(err instanceof Error ? err.message : "Failed to discover campaigns"); })
      .finally(() => setDiscovering(false));

    setAllLoading(true);
    fetch(`/api/campaigns?all=1&${instancesQuery}`)
      .then((r) => r.json())
      .then((data) => {
        const camps: AllCampaign[] = (data.campaigns || []).map((c: AllCampaign) => ({
          id: c.id, instance: c.instance, name: c.name, status: c.status,
        }));
        setAllCampaigns(camps);
      })
      .catch(() => { /* manual search just won't have anything to show */ })
      .finally(() => setAllLoading(false));
  }, [open, selectedDomains, instancesQuery]);

  const allListed = useMemo<CampaignInfo[]>(
    () => [...autoCampaigns, ...manualCampaigns],
    [autoCampaigns, manualCampaigns]
  );

  const filtered = useMemo(() => {
    if (!search) return allListed;
    const q = search.toLowerCase();
    return allListed.filter((c) => c.name.toLowerCase().includes(q));
  }, [allListed, search]);

  // Manual-add candidates: campaigns matching the search that aren't already in the list
  const searchResults = useMemo(() => {
    if (!search.trim()) return [];
    const q = search.toLowerCase();
    const existingIds = new Set(allListed.map((c) => c.id));
    return allCampaigns
      .filter((c) => !existingIds.has(c.id) && c.name.toLowerCase().includes(q))
      .slice(0, 20);
  }, [search, allCampaigns, allListed]);

  const selectedCampaigns = useMemo(
    () => allListed.filter((c) => selectedCampaignIds.has(c.id)),
    [allListed, selectedCampaignIds]
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

  const addManually = (c: AllCampaign) => {
    setManualCampaigns((prev) => [
      ...prev,
      { id: c.id, instance: c.instance, name: c.name, status: c.status, inboxCount: 0, source: "manual" },
    ]);
    setSelectedCampaignIds((prev) => new Set([...prev, c.id]));
  };

  // Chunked removal: one request PER CAMPAIGN so no single request can hit the
  // 300s function limit (a whole-selection removal of big clients used to 504).
  // Each request resolves that one campaign's senders live, intersects with the
  // domains, and removes. Progress is shown live and the completed campaigns are
  // already done server-side, so an interruption is safe to re-run (idempotent).
  const handleRemove = async () => {
    const campaigns = selectedCampaigns;       // snapshot at click time
    const domainsSnapshot = [...selectedDomains];
    setPhase("running");
    setError("");
    setResult(null);
    setRemoveProgress({ total: campaigns.length, done: 0, current: campaigns[0]?.name ?? null, details: [] });

    const details: RemoveDetail[] = [];
    for (let i = 0; i < campaigns.length; i++) {
      const c = campaigns[i];
      setRemoveProgress((p) => (p ? { ...p, current: c.name, done: i } : p));
      try {
        const data = await fetchJsonWithRetry(`/api/deliverability/remove-from-campaigns?${instancesQuery}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            domains: domainsSnapshot,
            campaigns: [{ id: c.id, instance: c.instance, name: c.name, status: c.status, inboxIds: c.inboxIds }],
          }),
        });
        const det: RemoveDetail = (data.details && data.details[0]) || { id: c.id, name: c.name, removed: data.removed ?? 0, error: data.error };
        details.push({ id: c.id, name: c.name, removed: det.removed ?? 0, error: det.error });
      } catch (err) {
        details.push({ id: c.id, name: c.name, removed: 0, error: err instanceof Error ? err.message : "Failed" });
      }
      setRemoveProgress((p) => (p ? { ...p, done: i + 1, details: [...details] } : p));
    }

    setResult({
      inboxes: 0,
      campaigns: details.length,
      removed: details.reduce((s, d) => s + d.removed, 0),
      details,
    });
    setPhase("done");
    onComplete();
  };

  // Closing is always allowed — the removal request keeps running server-side
  // and this component stays mounted in the page, so it finishes and refreshes
  // in the background (matching the "you can close this dialog" hint).
  const handleClose = () => {
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:!max-w-xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Remove from Campaigns</DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">
            {selectedDomains.length} domain{selectedDomains.length !== 1 ? "s" : ""} selected
          </p>
        </DialogHeader>

        {/* Select campaigns — search bar is always live; auto-discovery + full list load in background */}
        {phase === "select" && (
          <div className="flex flex-col gap-3 mt-2 flex-1 overflow-hidden">
            <p className="text-sm text-muted-foreground">
              {discovering
                ? "Detecting campaigns for these domains…"
                : autoCampaigns.length > 0
                  ? `Auto-detected ${autoCampaigns.length} campaign${autoCampaigns.length !== 1 ? "s" : ""}. Search to add more manually.`
                  : "No campaigns auto-detected for these domains. Use search to add manually."}
            </p>

            {/* Search — filters list above AND surfaces addable matches below. Always live. */}
            <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-1.5">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={allLoading ? "Loading all campaigns…" : "Search campaigns by name..."}
                className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
              />
              {allLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />}
              {search && <button onClick={() => setSearch("")}><X className="h-3 w-3 text-muted-foreground hover:text-foreground" /></button>}
            </div>

            {allListed.length > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {selectedCampaignIds.size} of {allListed.length} selected
                </span>
                <button onClick={toggleAll} className="text-xs text-primary hover:underline">
                  {selectedCampaignIds.size === filtered.length ? "Deselect all" : "Select all"}
                </button>
              </div>
            )}

            {/* To-remove list (auto + manual combined) */}
            <div className="flex-1 overflow-y-auto rounded-lg border divide-y min-h-[100px]">
              {discovering && allListed.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-6 gap-2">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Finding campaigns for these domains…</span>
                </div>
              ) : filtered.length === 0 && allListed.length === 0 && !search ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  No campaigns selected yet. Search above to add some.
                </div>
              ) : filtered.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                  No selected campaigns match your search.
                </div>
              ) : (
                filtered.map((c) => {
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
                      {c.source === "manual" && (
                        <Badge variant="outline" className="text-[9px] px-1.5 py-0 shrink-0 border-blue-500/30 text-blue-400">
                          manual
                        </Badge>
                      )}
                      <Badge variant="outline" className={`text-[9px] px-1.5 py-0 shrink-0 ${STATUS_COLORS[c.status.toLowerCase()] || ""}`}>
                        {c.status}
                      </Badge>
                    </button>
                  );
                })
              )}
            </div>

            {/* Manual-add results — only show when search has matches not already added */}
            {searchResults.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">Add manually:</p>
                <div className="max-h-40 overflow-y-auto rounded-lg border divide-y">
                  {searchResults.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => addManually(c)}
                      className="flex items-center gap-3 w-full px-3 py-2 text-sm hover:bg-muted/50 transition-colors text-left"
                    >
                      <Plus className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="truncate flex-1">{c.name}</span>
                      <Badge variant="outline" className={`text-[9px] px-1.5 py-0 shrink-0 ${STATUS_COLORS[c.status.toLowerCase()] || ""}`}>
                        {c.status}
                      </Badge>
                    </button>
                  ))}
                </div>
              </div>
            )}

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
                  This will remove the selected domains&apos; inboxes from {selectedCampaigns.length} campaign{selectedCampaigns.length !== 1 ? "s" : ""}, one campaign at a time.
                  Each campaign is checked live — inboxes are only removed where your domains are actually attached (campaigns they aren&apos;t in show 0).
                  Active campaigns are paused during removal, then resumed automatically.
                </p>
              </div>
            </div>

            <div className="max-h-40 overflow-y-auto rounded-lg border divide-y">
              {selectedCampaigns.map((c) => (
                <div key={c.id} className="flex items-center justify-between px-3 py-2">
                  <span className="text-xs truncate flex-1">{c.name}</span>
                  <div className="flex items-center gap-2 shrink-0 ml-2">
                    {c.source === "manual" && (
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-blue-500/30 text-blue-400">manual</Badge>
                    )}
                    <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${STATUS_COLORS[c.status.toLowerCase()] || ""}`}>{c.status}</Badge>
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

        {/* Running — chunked, one campaign at a time, with live progress */}
        {phase === "running" && (
          <div className="flex flex-col gap-3 py-4 mt-2">
            <div className="flex items-center gap-3">
              <Loader2 className="h-5 w-5 animate-spin text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm">
                  Removing — {removeProgress?.done ?? 0}/{removeProgress?.total ?? 0} campaigns
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  {removeProgress?.current ? `Processing: ${removeProgress.current}` : "Pausing active campaigns, removing, then resuming."}
                </p>
              </div>
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${removeProgress && removeProgress.total ? (removeProgress.done / removeProgress.total) * 100 : 0}%` }}
              />
            </div>
            {removeProgress && removeProgress.details.length > 0 && (
              <div className="max-h-40 overflow-y-auto rounded-lg border divide-y">
                {removeProgress.details.map((d) => (
                  <div key={d.id} className="flex items-center justify-between px-3 py-1.5">
                    <span className="text-xs truncate flex-1">{d.name}</span>
                    {d.error
                      ? <span className="text-[10px] text-destructive ml-2 shrink-0">{d.error}</span>
                      : <span className="text-[10px] text-muted-foreground ml-2 shrink-0">{d.removed} removed</span>}
                  </div>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground/60">
              Each campaign is processed in its own request, so this won&apos;t time out. You can close this — it keeps running in the background, and it&apos;s safe to re-run if interrupted.
            </p>
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
