"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Search, X, Check, Plus, Loader2 } from "lucide-react";
import { useInstance } from "@/lib/instance-context";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

interface Tag { id: number; name: string }
interface Campaign { id: number; instance: BisonInstanceSlug; name: string; status: string; client_tag: string }

export interface TagApplyInfo {
  mode: "add" | "remove";
  tagNames: string[];
  domains: string[];
  /** Campaigns to attach domains to (empty if skipped) */
  campaigns: { id: number; name: string; instance: BisonInstanceSlug }[];
  /** If set, also append domains to this client's Domains sheet */
  sheetAppend?: { clientTag: string } | null;
}

interface BulkTagDialogProps {
  mode: "add" | "remove";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedDomains: string[];
  existingTags?: string[];
  availableTags?: Tag[];
  /** Called with full selection — parent handles background execution */
  onApply: (info: TagApplyInfo) => void;
}

const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
  paused: "bg-amber-500/10 text-amber-500 border-amber-500/20",
  draft: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
};

export function BulkTagDialog({
  mode, open, onOpenChange, selectedDomains, existingTags, availableTags, onApply,
}: BulkTagDialogProps) {
  const { instances, instancesQuery } = useInstance();
  const [phase, setPhase] = useState<"tags" | "campaigns" | "sheet">("tags");
  // Tag names (deduped across all selected instances). Bison tag IDs are
  // instance-scoped, so selection is by NAME — the backend resolves/creates the
  // matching tag per instance at apply time.
  const [allTagNames, setAllTagNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedTagNames, setSelectedTagNames] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [newTagName, setNewTagName] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Campaign selection
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedCampaignIds, setSelectedCampaignIds] = useState<Set<number>>(new Set());
  const [campaignSearch, setCampaignSearch] = useState("");
  const [campaignsLoading, setCampaignsLoading] = useState(false);

  // Saved tag selection
  const [savedTagNames, setSavedTagNames] = useState<string[]>([]);

  // Sheet append selection
  const [savedCampaigns, setSavedCampaigns] = useState<{ id: number; name: string; instance: BisonInstanceSlug }[]>([]);
  const [availableSheets, setAvailableSheets] = useState<{ clientTag: string; sheetName: string }[]>([]);
  const [sheetsLoading, setSheetsLoading] = useState(false);
  const [selectedSheetTag, setSelectedSheetTag] = useState<string | null>(null);
  const [sheetSearch, setSheetSearch] = useState("");

  useEffect(() => {
    if (!open) return;
    setPhase("tags");
    setSelectedTagNames(new Set());
    setSearch("");
    setNewTagName("");
    setError(null);
    setCampaigns([]);
    setSelectedCampaignIds(new Set());
    setCampaignSearch("");
    setSheetSearch("");
    setSelectedSheetTag(null);

    // Pull tags from every selected Bison instance and union by name — the
    // dialog can span instances when tier = "all".
    setLoading(true);
    Promise.all(
      instances.map((inst) =>
        fetch(`/api/deliverability/bulk-tags?instance=${encodeURIComponent(inst.slug)}`)
          .then((r) => r.json())
          .catch(() => ({ tags: [] }))
      )
    )
      .then((results) => {
        const set = new Set<string>();
        for (const r of results) {
          for (const t of ((r?.tags || []) as Tag[])) {
            if (t?.name) set.add(t.name);
          }
        }
        setAllTagNames(Array.from(set).sort((a, b) => a.localeCompare(b)));
      })
      .catch(() => setError("Failed to load tags"))
      .finally(() => setLoading(false));
  }, [open, instances]);

  const availableNames = useMemo(() => new Set((availableTags || []).map((t) => t.name)), [availableTags]);
  const tagNamesList = useMemo(
    () => (mode === "add" ? allTagNames : allTagNames.filter((n) => availableNames.has(n))),
    [mode, allTagNames, availableNames]
  );
  const filtered = useMemo(() => {
    if (!search) return tagNamesList;
    const q = search.toLowerCase();
    return tagNamesList.filter((n) => n.toLowerCase().includes(q));
  }, [tagNamesList, search]);
  const selectedNames = tagNamesList.filter((n) => selectedTagNames.has(n));

  const toggleTag = (name: string) => {
    setSelectedTagNames((prev) => { const n = new Set(prev); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  };

  // "Create" just stages the name locally — the backend auto-creates the tag in
  // each target instance at apply time (so it lands in the right Bison instance).
  const handleCreateTag = () => {
    const name = newTagName.trim();
    if (!name) return;
    setError(null);
    setAllTagNames((prev) => (prev.includes(name) ? prev : [...prev, name].sort((a, b) => a.localeCompare(b))));
    setSelectedTagNames((prev) => new Set([...prev, name]));
    setNewTagName("");
  };

  const handleTagsConfirmed = () => {
    if (selectedTagNames.size === 0) return;
    const names = Array.from(selectedTagNames);
    setSavedTagNames(names);

    if (mode === "remove") {
      // Remove mode: close immediately, no campaign step
      onApply({ mode, tagNames: names, domains: [...selectedDomains], campaigns: [] });
      onOpenChange(false);
    } else {
      loadCampaignsForTags(names);
    }
  };

  const loadCampaignsForTags = useCallback(async (newTagNames: string[]) => {
    setCampaignsLoading(true);
    setPhase("campaigns");
    try {
      const res = await fetch(`/api/campaigns?all=1&${instancesQuery}`);
      const data = await res.json();
      const allCampaigns: Campaign[] = data.campaigns || (Array.isArray(data) ? data : []);
      const allRelevantTags = new Set([...(existingTags || []), ...newTagNames]);
      const matching = allCampaigns.filter((c) =>
        c.status.toLowerCase() !== "archived" && c.status.toLowerCase() !== "completed" && allRelevantTags.has(c.client_tag)
      );
      setCampaigns(matching);
      setSelectedCampaignIds(new Set(matching.map((c) => c.id)));
    } catch { setCampaigns([]); }
    finally { setCampaignsLoading(false); }
  }, [existingTags, instancesQuery]);

  const filteredCampaigns = useMemo(() => {
    if (!campaignSearch) return campaigns;
    const q = campaignSearch.toLowerCase();
    return campaigns.filter((c) => c.name.toLowerCase().includes(q));
  }, [campaigns, campaignSearch]);

  const filteredSheets = useMemo(() => {
    if (!sheetSearch) return availableSheets;
    const q = sheetSearch.toLowerCase();
    return availableSheets.filter(
      (s) => s.clientTag.toLowerCase().includes(q) || s.sheetName.toLowerCase().includes(q)
    );
  }, [availableSheets, sheetSearch]);

  const toggleCampaign = (id: number) => {
    setSelectedCampaignIds((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  const transitionToSheet = (camps: { id: number; name: string; instance: BisonInstanceSlug }[]) => {
    setSavedCampaigns(camps);
    setSheetsLoading(true);
    setPhase("sheet");
    // Fetch tracked sheets directly (fast, no Google Sheets API calls)
    fetch("/api/sheets")
      .then((r) => r.json())
      .then((data) => {
        const sheets: { clientTag: string; sheetName: string }[] = (Array.isArray(data) ? data : []).map((s: { clientTag: string; name: string }) => ({
          clientTag: s.clientTag,
          sheetName: s.name,
        }));
        setAvailableSheets(sheets);
        // Auto-detect: match tag names being added to available sheet clientTags
        const sheetTags = new Set(sheets.map((s) => s.clientTag));
        const match = savedTagNames.find((t) => sheetTags.has(t));
        setSelectedSheetTag(match || sheets[0]?.clientTag || null);
      })
      .catch(() => setAvailableSheets([]))
      .finally(() => setSheetsLoading(false));
  };

  const handleConfirmAll = () => {
    const selectedCamps = campaigns.filter((c) => selectedCampaignIds.has(c.id)).map((c) => ({ id: c.id, name: c.name, instance: c.instance }));
    transitionToSheet(selectedCamps);
  };

  const handleSkipCampaigns = () => {
    transitionToSheet([]);
  };

  const handleSheetConfirm = () => {
    onApply({ mode, tagNames: savedTagNames, domains: [...selectedDomains], campaigns: savedCampaigns, sheetAppend: selectedSheetTag ? { clientTag: selectedSheetTag } : null });
    onOpenChange(false);
  };

  const handleSheetSkip = () => {
    onApply({ mode, tagNames: savedTagNames, domains: [...selectedDomains], campaigns: savedCampaigns, sheetAppend: null });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:!max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {phase === "sheet"
              ? "Add to Domains Sheet"
              : phase === "campaigns"
              ? "Select Campaigns"
              : `${mode === "add" ? "Add Tags" : "Remove Tags"} — ${selectedDomains.length} domain${selectedDomains.length !== 1 ? "s" : ""}`}
          </DialogTitle>
        </DialogHeader>

        {/* ── Tag Selection ── */}
        {phase === "tags" && (
          <div className="space-y-3 flex-1 overflow-hidden flex flex-col">
            {mode === "add" && (
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-1.5 flex-1">
                  <Plus className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <input value={newTagName} onChange={(e) => setNewTagName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleCreateTag()}
                    placeholder="Create new tag…" className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground" />
                </div>
                <Button size="sm" variant="outline" disabled={!newTagName.trim()} onClick={handleCreateTag}>
                  Create
                </Button>
              </div>
            )}
            <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-1.5">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search tags…" className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground" />
              {search && <button onClick={() => setSearch("")}><X className="h-3 w-3 text-muted-foreground hover:text-foreground" /></button>}
            </div>
            {loading ? (
              <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-6 text-sm text-muted-foreground">{search ? "No tags match" : "No tags available"}</div>
            ) : (
              <div className="flex-1 overflow-y-auto rounded-lg border divide-y">
                {filtered.map((name) => {
                  const selected = selectedTagNames.has(name);
                  return (
                    <button key={name} onClick={() => toggleTag(name)}
                      className={`flex items-center gap-2.5 w-full px-3 py-2 text-sm text-left transition-colors ${selected ? "bg-primary/10" : "hover:bg-muted/50"}`}>
                      <div className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 transition-colors ${selected ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30"}`}>
                        {selected && <Check className="h-3 w-3" />}
                      </div>
                      <span className="truncate">{name}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {selectedNames.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {selectedNames.map((name) => (
                  <span key={name} className="text-[10px] bg-primary/10 text-primary border border-primary/20 rounded-full px-2 py-0.5">{name}</span>
                ))}
              </div>
            )}
            {error && <div className="text-xs text-destructive">{error}</div>}
            <div className="flex items-center justify-between pt-1">
              <span className="text-xs text-muted-foreground">{selectedTagNames.size} tag{selectedTagNames.size !== 1 ? "s" : ""} selected</span>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
                <Button size="sm" disabled={selectedTagNames.size === 0} onClick={handleTagsConfirmed}
                  variant={mode === "remove" ? "destructive" : "default"}>
                  {mode === "add" ? "Next" : "Remove Tags"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ── Campaign Selection ── */}
        {phase === "campaigns" && (
          <div className="space-y-3 flex-1 overflow-hidden flex flex-col">
            <p className="text-sm text-muted-foreground">
              Also attach these {selectedDomains.length} domains to campaigns?
            </p>
            {campaignsLoading ? (
              <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : campaigns.length === 0 ? (
              <div className="text-center py-6 text-sm text-muted-foreground">No matching campaigns found for these tags.</div>
            ) : (
              <>
                <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-1.5">
                  <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <input value={campaignSearch} onChange={(e) => setCampaignSearch(e.target.value)}
                    placeholder="Search campaigns…" className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground" />
                  {campaignSearch && <button onClick={() => setCampaignSearch("")}><X className="h-3 w-3 text-muted-foreground hover:text-foreground" /></button>}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{selectedCampaignIds.size} of {campaigns.length} selected</span>
                  <button onClick={() => {
                    if (selectedCampaignIds.size === filteredCampaigns.length) setSelectedCampaignIds(new Set());
                    else setSelectedCampaignIds(new Set(filteredCampaigns.map((c) => c.id)));
                  }} className="text-xs text-primary hover:underline">
                    {selectedCampaignIds.size === filteredCampaigns.length ? "Deselect all" : "Select all"}
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto rounded-lg border divide-y">
                  {filteredCampaigns.map((c) => {
                    const selected = selectedCampaignIds.has(c.id);
                    return (
                      <button key={c.id} onClick={() => toggleCampaign(c.id)}
                        className={`flex items-center gap-3 w-full px-3 py-2.5 text-sm transition-colors ${selected ? "bg-primary/5" : "hover:bg-muted/50"}`}>
                        <div className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 transition-colors ${selected ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30"}`}>
                          {selected && <Check className="h-3 w-3" />}
                        </div>
                        <span className="truncate flex-1 text-left">{c.name}</span>
                        <Badge variant="outline" className={`text-[9px] px-1.5 py-0 shrink-0 ${STATUS_COLORS[c.status.toLowerCase()] || ""}`}>{c.status}</Badge>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={handleSkipCampaigns}>Skip</Button>
              <Button size="sm" onClick={handleConfirmAll}>
                {selectedCampaignIds.size > 0
                  ? `Attach to ${selectedCampaignIds.size} Campaign${selectedCampaignIds.size !== 1 ? "s" : ""} & Next`
                  : "Next"}
              </Button>
            </div>
          </div>
        )}

        {/* ── Sheet Append Selection ── */}
        {phase === "sheet" && (
          <div className="space-y-3 flex-1 overflow-hidden flex flex-col">
            <p className="text-sm text-muted-foreground">
              Also add these {selectedDomains.length} domains to a client&apos;s Domains sheet?
            </p>

            {sheetsLoading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : availableSheets.length === 0 ? (
              <div className="text-sm text-muted-foreground py-4">No tracked sheets found.</div>
            ) : (
              <>
                <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-1.5">
                  <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <input value={sheetSearch} onChange={(e) => setSheetSearch(e.target.value)}
                    placeholder="Search client sheets…" className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground" />
                  {sheetSearch && <button onClick={() => setSheetSearch("")}><X className="h-3 w-3 text-muted-foreground hover:text-foreground" /></button>}
                </div>
                <div className="flex-1 overflow-y-auto rounded-lg border divide-y">
                  {filteredSheets.length === 0 ? (
                    <div className="text-center py-6 text-sm text-muted-foreground">No sheets match</div>
                  ) : (
                    filteredSheets.map((s) => {
                      const selected = selectedSheetTag === s.clientTag;
                      return (
                        <button key={s.clientTag} onClick={() => setSelectedSheetTag(s.clientTag)}
                          className={`flex items-center gap-2.5 w-full px-3 py-2 text-sm text-left transition-colors ${selected ? "bg-primary/10" : "hover:bg-muted/50"}`}>
                          <div className={`h-4 w-4 rounded-full border flex items-center justify-center shrink-0 transition-colors ${selected ? "bg-primary border-primary" : "border-muted-foreground/30"}`}>
                            {selected && <div className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />}
                          </div>
                          <span className="font-medium shrink-0">{s.clientTag}</span>
                          <span className="text-muted-foreground truncate">— {s.sheetName}</span>
                        </button>
                      );
                    })
                  )}
                </div>
                {selectedSheetTag && (
                  <div className="text-xs text-muted-foreground rounded-lg border bg-muted/30 px-3 py-2">
                    Target: <span className="font-medium text-foreground">{availableSheets.find((s) => s.clientTag === selectedSheetTag)?.sheetName}</span> &rarr; Domains tab
                  </div>
                )}
              </>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={handleSheetSkip}>Skip</Button>
              <Button size="sm" disabled={!selectedSheetTag || availableSheets.length === 0} onClick={handleSheetConfirm}>
                Add to Sheet
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
