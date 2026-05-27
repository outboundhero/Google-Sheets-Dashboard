"use client";

/**
 * Right-corner "Attach to Campaigns" dialog (Deliverability page).
 *
 * Lists every campaign in the selected instance group that has a matching
 * Bison tag (auto-derived from the campaign name prefix). User picks which
 * campaigns to attach — checkboxes, search, status filter, group-by-client-
 * tag, and a manual-add lane for campaigns the auto-detector missed.
 *
 * Each row is one campaign on one specific Bison instance — POSTs respect
 * that so a cross-instance batch routes correctly.
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
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Link2,
  Loader2,
  Plus,
  Search,
  X,
  XCircle,
} from "lucide-react";
import { BISON_INSTANCES, type BisonInstanceSlug } from "@/lib/bison-instances";

interface CampaignPreview {
  campaign_id: number;
  instance: BisonInstanceSlug;
  campaign_name: string;
  client_tag: string;
  tag_id: number | null;
  has_tag: boolean;
  campaign_status: string;
  source?: "auto" | "manual";
}

interface AttachResult {
  campaign_id: number;
  instance: BisonInstanceSlug;
  campaign_name: string;
  total_matched: number;
  already_attached: number;
  newly_attached: number;
  error?: string;
}

interface AllCampaign {
  id: number;
  instance: BisonInstanceSlug;
  name: string;
  status: string;
  client_tag: string;
}

type Phase = "loading" | "select" | "attaching" | "done";
type StatusFilter = "all" | "active" | "paused" | "draft";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  instancesQuery: string;
}

const STATUS_ORDER: Record<string, number> = {
  Active: 0,
  active: 0,
  Launching: 1,
  launching: 1,
  Queued: 2,
  queued: 2,
  Draft: 3,
  draft: 3,
  Paused: 4,
  paused: 4,
  Completed: 5,
  completed: 5,
};

function statusBadge(status: string) {
  const s = status.toLowerCase();
  if (s === "active") return <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px]">Active</Badge>;
  if (s === "paused") return <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30 text-[10px]">Paused</Badge>;
  if (s === "draft") return <Badge className="bg-blue-500/15 text-blue-400 border-blue-500/30 text-[10px]">Draft</Badge>;
  if (s === "completed") return <Badge variant="outline" className="text-[10px]">Completed</Badge>;
  return <Badge variant="outline" className="text-[10px]">{status}</Badge>;
}

export function AttachCampaignsDialog({ open, onOpenChange, instancesQuery }: Props) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [autoCampaigns, setAutoCampaigns] = useState<CampaignPreview[]>([]);
  const [manualCampaigns, setManualCampaigns] = useState<CampaignPreview[]>([]);
  const [allCampaigns, setAllCampaigns] = useState<AllCampaign[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set()); // key = `${instance}:${id}`
  const [results, setResults] = useState<AttachResult[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [collapsedTags, setCollapsedTags] = useState<Set<string>>(new Set());

  // Reset on open. We do NOT depend on instancesQuery for re-fetches — the
  // parent rebuilds it on every render so depending on it would wipe the
  // result view while results are streaming in.
  useEffect(() => {
    if (!open) {
      setPhase("loading");
      setAutoCampaigns([]);
      setManualCampaigns([]);
      setAllCampaigns([]);
      setSelected(new Set());
      setResults([]);
      setCurrentIndex(0);
      setError(null);
      setSearch("");
      setStatusFilter("all");
      setCollapsedTags(new Set());
      return;
    }
    setPhase("loading");
    setError(null);

    // 1) Auto-detected campaigns (matching tags)
    const autoP = fetch(`/api/deliverability/attach-campaigns?${instancesQuery}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load");
        const list: CampaignPreview[] = Array.isArray(data) ? data : [];
        const tagged = list
          .filter((c) => c.has_tag)
          .map((c) => ({ ...c, source: "auto" as const }));
        setAutoCampaigns(tagged);
        // Pre-select all auto-detected campaigns by default — matches the old
        // "Attach All" behaviour but now individually deselectable.
        const next = new Set<string>();
        for (const c of tagged) next.add(`${c.instance}:${c.campaign_id}`);
        setSelected(next);
      });

    // 2) All campaigns from the current group (for manual add)
    const allP = fetch(`/api/campaigns?all=1&${instancesQuery}`)
      .then(async (res) => {
        const data = await res.json();
        const raw: AllCampaign[] = (data?.campaigns || []).map((c: AllCampaign) => ({
          id: c.id,
          instance: c.instance,
          name: c.name,
          status: c.status,
          client_tag: c.client_tag,
        }));
        setAllCampaigns(raw);
      })
      .catch(() => { /* manual search just won't have anything to show */ });

    Promise.allSettled([autoP, allP]).then(([d]) => {
      if (d.status === "rejected") {
        setError((d.reason as Error)?.message || "Failed to load campaigns");
      }
      setPhase("select");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ─── Derived data ─────────────────────────────────────────────────────────
  const allListed = useMemo<CampaignPreview[]>(
    () => [...autoCampaigns, ...manualCampaigns],
    [autoCampaigns, manualCampaigns],
  );

  // Status filter + search filter applied to the visible list.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allListed.filter((c) => {
      if (statusFilter !== "all") {
        if (c.campaign_status.toLowerCase() !== statusFilter) return false;
      }
      if (q && !c.campaign_name.toLowerCase().includes(q)
            && !c.client_tag.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [allListed, search, statusFilter]);

  // Group by client_tag for the collapsible sections.
  const groups = useMemo(() => {
    const m = new Map<string, CampaignPreview[]>();
    for (const c of filtered) {
      const key = c.client_tag || "(no tag)";
      const arr = m.get(key);
      if (arr) arr.push(c);
      else m.set(key, [c]);
    }
    // Stable sort within group: Active first, then by name.
    for (const arr of m.values()) {
      arr.sort((a, b) => {
        const oa = STATUS_ORDER[a.campaign_status] ?? 99;
        const ob = STATUS_ORDER[b.campaign_status] ?? 99;
        if (oa !== ob) return oa - ob;
        return a.campaign_name.localeCompare(b.campaign_name);
      });
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  // Manual-add candidates: matches in /api/campaigns not already shown.
  const manualMatches = useMemo<AllCampaign[]>(() => {
    if (!search.trim()) return [];
    const q = search.toLowerCase();
    const existing = new Set(allListed.map((c) => `${c.instance}:${c.campaign_id}`));
    return allCampaigns
      .filter((c) => !existing.has(`${c.instance}:${c.id}`))
      .filter((c) => c.name.toLowerCase().includes(q) || c.client_tag.toLowerCase().includes(q))
      .slice(0, 15);
  }, [search, allCampaigns, allListed]);

  const statusCounts = useMemo(() => {
    const m: Record<string, number> = { all: allListed.length, active: 0, paused: 0, draft: 0 };
    for (const c of allListed) {
      const s = c.campaign_status.toLowerCase();
      if (m[s] !== undefined) m[s]++;
    }
    return m;
  }, [allListed]);

  const toggleOne = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleGroup = (clientTag: string, on: boolean) => {
    const groupKeys = (groups.find(([k]) => k === clientTag)?.[1] ?? []).map((c) => `${c.instance}:${c.campaign_id}`);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of groupKeys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  };
  const allFilteredSelected = filtered.length > 0 && filtered.every((c) => selected.has(`${c.instance}:${c.campaign_id}`));
  const toggleAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      const visibleKeys = filtered.map((c) => `${c.instance}:${c.campaign_id}`);
      if (allFilteredSelected) {
        for (const k of visibleKeys) next.delete(k);
      } else {
        for (const k of visibleKeys) next.add(k);
      }
      return next;
    });
  };

  const toggleCollapse = (k: string) => {
    setCollapsedTags((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const addManually = (c: AllCampaign) => {
    const clientTag = c.client_tag || c.name.split(":")[0].trim();
    setManualCampaigns((prev) => [
      ...prev,
      {
        campaign_id: c.id,
        instance: c.instance,
        campaign_name: c.name,
        client_tag: clientTag,
        // tag_id unknown for manual — backend will resolve from tag name on POST
        // (existing POST requires tag_id; manual adds will get it via a small lookup
        // if not present). For now we mark has_tag false and the POST step handles it.
        tag_id: null,
        has_tag: false,
        campaign_status: c.status,
        source: "manual",
      },
    ]);
    setSelected((prev) => new Set(prev).add(`${c.instance}:${c.id}`));
    setSearch("");
  };

  const selectedList = useMemo(
    () => allListed.filter((c) => selected.has(`${c.instance}:${c.campaign_id}`)),
    [allListed, selected],
  );

  // ─── Attach all selected ──────────────────────────────────────────────────
  const handleAttach = async () => {
    if (selectedList.length === 0) return;
    setPhase("attaching");
    setResults([]);
    setCurrentIndex(0);

    for (let i = 0; i < selectedList.length; i++) {
      setCurrentIndex(i);
      const c = selectedList[i];
      try {
        const res = await fetch(`/api/deliverability/attach-campaigns?instance=${c.instance}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            campaign_id: c.campaign_id,
            campaign_name: c.campaign_name,
            client_tag: c.client_tag,
            tag_id: c.tag_id,
          }),
        });
        const result = await res.json();
        if (!res.ok) {
          setResults((prev) => [...prev, {
            campaign_id: c.campaign_id,
            instance: c.instance,
            campaign_name: c.campaign_name,
            total_matched: 0, already_attached: 0, newly_attached: 0,
            error: result.error || "Failed",
          }]);
        } else {
          setResults((prev) => [...prev, { ...result, instance: c.instance, campaign_name: c.campaign_name }]);
        }
      } catch (e) {
        setResults((prev) => [...prev, {
          campaign_id: c.campaign_id,
          instance: c.instance,
          campaign_name: c.campaign_name,
          total_matched: 0, already_attached: 0, newly_attached: 0,
          error: e instanceof Error ? e.message : "Network error",
        }]);
      }
    }
    setPhase("done");
  };

  const totalNewlyAttached = results.reduce((s, r) => s + r.newly_attached, 0);
  const totalAlreadyAttached = results.reduce((s, r) => s + r.already_attached, 0);
  const totalErrors = results.filter((r) => r.error).length;

  return (
    <Dialog open={open} onOpenChange={(v) => phase !== "attaching" && onOpenChange(v)}>
      <DialogContent className="sm:!max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-5 w-5" />
            Attach Inboxes to Campaigns
          </DialogTitle>
          <DialogDescription>
            Pick which campaigns to attach matching tagged inboxes to. Auto-detected ones (matching Bison tag) are pre-selected — uncheck any you want to skip. Search to filter or add campaigns manually.
          </DialogDescription>
        </DialogHeader>

        {phase === "loading" && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Loading campaigns across selected instances…</p>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {/* SELECT PHASE */}
        {phase === "select" && (
          <div className="flex flex-col gap-3 flex-1 overflow-hidden">
            {/* Search */}
            <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-1.5">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search campaigns or client tag…"
                className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
              />
              {search && (
                <button onClick={() => setSearch("")}>
                  <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                </button>
              )}
            </div>

            {/* Status filter pills */}
            <div className="flex flex-wrap gap-1.5 items-center text-xs">
              {(["all", "active", "paused", "draft"] as StatusFilter[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`px-2.5 py-1 rounded-full border capitalize transition-colors ${
                    statusFilter === s
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                  }`}
                >
                  {s === "all" ? "All" : s}
                  <span className="ml-1 opacity-60">{statusCounts[s] ?? 0}</span>
                </button>
              ))}
              <div className="flex-1" />
              <button onClick={toggleAllVisible} className="text-xs text-primary hover:underline">
                {allFilteredSelected ? "Deselect visible" : "Select visible"}
              </button>
            </div>

            {/* Grouped list */}
            <div className="flex-1 overflow-y-auto rounded-lg border divide-y min-h-[120px]">
              {groups.length === 0 ? (
                <div className="px-3 py-10 text-center text-xs text-muted-foreground">
                  {allListed.length === 0
                    ? "No campaigns with matching tags found in the selected group."
                    : "No campaigns match the current filters."}
                </div>
              ) : (
                groups.map(([clientTag, items]) => {
                  const groupKeys = items.map((c) => `${c.instance}:${c.campaign_id}`);
                  const groupSelected = groupKeys.filter((k) => selected.has(k)).length;
                  const allOn = groupSelected === groupKeys.length && groupKeys.length > 0;
                  const collapsed = collapsedTags.has(clientTag);
                  return (
                    <div key={clientTag} className="bg-muted/10">
                      <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/30">
                        <button onClick={() => toggleCollapse(clientTag)} className="text-muted-foreground hover:text-foreground">
                          {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                        </button>
                        <button
                          onClick={() => toggleGroup(clientTag, !allOn)}
                          className={`h-3.5 w-3.5 rounded border flex items-center justify-center shrink-0 transition-colors ${
                            allOn
                              ? "bg-primary border-primary text-primary-foreground"
                              : groupSelected > 0
                                ? "bg-primary/40 border-primary"
                                : "border-muted-foreground/30"
                          }`}
                          title={allOn ? "Deselect group" : "Select group"}
                        >
                          {allOn && <Check className="h-2.5 w-2.5" />}
                        </button>
                        <span className="text-xs font-medium">{clientTag}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {groupSelected}/{groupKeys.length}
                        </span>
                      </div>
                      {!collapsed && (
                        <div className="divide-y">
                          {items.map((c) => {
                            const key = `${c.instance}:${c.campaign_id}`;
                            const isSelected = selected.has(key);
                            return (
                              <button
                                key={key}
                                onClick={() => toggleOne(key)}
                                className={`flex items-center gap-3 w-full px-3 py-2 text-sm transition-colors ${
                                  isSelected ? "bg-primary/5" : "hover:bg-muted/30"
                                }`}
                              >
                                <div className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                                  isSelected ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30"
                                }`}>
                                  {isSelected && <Check className="h-3 w-3" />}
                                </div>
                                <span className="truncate flex-1 text-left">{c.campaign_name}</span>
                                {c.source === "manual" && (
                                  <Badge variant="outline" className="text-[9px] px-1.5 py-0 shrink-0 border-blue-500/30 text-blue-400">manual</Badge>
                                )}
                                <span className="text-[10px] text-muted-foreground shrink-0">
                                  {BISON_INSTANCES[c.instance]?.label ?? c.instance}
                                </span>
                                {statusBadge(c.campaign_status)}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Manual-add results — surface when search has matches not yet in list */}
            {manualMatches.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">Add manually:</p>
                <div className="max-h-40 overflow-y-auto rounded-lg border divide-y">
                  {manualMatches.map((c) => (
                    <button
                      key={`${c.instance}:${c.id}`}
                      onClick={() => addManually(c)}
                      className="flex items-center gap-3 w-full px-3 py-2 text-sm hover:bg-muted/50 transition-colors text-left"
                    >
                      <Plus className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="truncate flex-1">{c.name}</span>
                      <span className="text-[10px] text-muted-foreground shrink-0">{BISON_INSTANCES[c.instance]?.label ?? c.instance}</span>
                      {statusBadge(c.status)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <DialogFooter className="!justify-between border-t pt-3">
              <div className="text-xs text-muted-foreground">
                {selected.size} of {allListed.length} selected
              </div>
              <Button onClick={handleAttach} disabled={selected.size === 0} className="gap-2">
                <Link2 className="h-4 w-4" />
                Attach to {selected.size} campaign{selected.size !== 1 ? "s" : ""}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* ATTACHING / DONE — progress + per-campaign result rows */}
        {(phase === "attaching" || phase === "done") && (
          <div className="flex flex-col gap-3 flex-1 overflow-hidden">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {phase === "attaching"
                    ? `Processing ${currentIndex + 1} of ${selectedList.length}…`
                    : "Complete"}
                </span>
                <span className="font-medium">{results.length}/{selectedList.length}</span>
              </div>
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${phase === "done" ? "bg-emerald-500" : "bg-primary"}`}
                  style={{ width: `${(results.length / Math.max(selectedList.length, 1)) * 100}%` }}
                />
              </div>
            </div>

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

            <div className="flex-1 overflow-y-auto rounded-lg border divide-y">
              {results.map((r) => (
                <div
                  key={`${r.instance}:${r.campaign_id}`}
                  className={`flex items-center gap-3 px-3 py-2 text-sm ${
                    r.error ? "bg-destructive/5" : ""
                  }`}
                >
                  {r.error ? (
                    <XCircle className="h-4 w-4 text-destructive shrink-0" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                  )}
                  <span className="truncate flex-1">{r.campaign_name}</span>
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    {BISON_INSTANCES[r.instance]?.label ?? r.instance}
                  </span>
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
              {phase === "attaching" && currentIndex < selectedList.length && (
                <div className="flex items-center gap-3 px-3 py-2 text-sm bg-primary/5">
                  <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
                  <span className="truncate flex-1">{selectedList[currentIndex]?.campaign_name}</span>
                  <span className="text-xs text-muted-foreground">Processing…</span>
                </div>
              )}
            </div>

            {phase === "done" && (
              <DialogFooter className="!justify-between border-t pt-3">
                <span className="text-sm text-muted-foreground">
                  {totalNewlyAttached.toLocaleString()} inboxes attached across {results.filter((r) => r.newly_attached > 0).length} campaigns
                </span>
                <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Close</Button>
              </DialogFooter>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
