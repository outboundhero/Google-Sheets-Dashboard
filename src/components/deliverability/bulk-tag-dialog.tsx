"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Search, X, Check, Plus, Loader2, ChevronDown } from "lucide-react";

interface Tag { id: number; name: string }
interface Campaign { id: number; name: string; status: string; client_tag: string }

export interface TagApplyInfo {
  mode: "add" | "remove";
  tagIds: number[];
  tagNames: string[];
  domains: string[];
  /** Campaigns to attach domains to (empty if skipped) */
  campaigns: { id: number; name: string }[];
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
  const [phase, setPhase] = useState<"tags" | "campaigns" | "sheet">("tags");
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedTagIds, setSelectedTagIds] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const [newTagName, setNewTagName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Campaign selection
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedCampaignIds, setSelectedCampaignIds] = useState<Set<number>>(new Set());
  const [campaignSearch, setCampaignSearch] = useState("");
  const [campaignsLoading, setCampaignsLoading] = useState(false);

  // Saved tag selection
  const [savedTagIds, setSavedTagIds] = useState<number[]>([]);
  const [savedTagNames, setSavedTagNames] = useState<string[]>([]);

  // Sheet append selection
  const [savedCampaigns, setSavedCampaigns] = useState<{ id: number; name: string }[]>([]);
  const [availableSheets, setAvailableSheets] = useState<{ clientTag: string; sheetName: string }[]>([]);
  const [sheetsLoading, setSheetsLoading] = useState(false);
  const [selectedSheetTag, setSelectedSheetTag] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPhase("tags");
    setSelectedTagIds(new Set());
    setSearch("");
    setNewTagName("");
    setError(null);
    setCampaigns([]);
    setSelectedCampaignIds(new Set());
    setCampaignSearch("");

    setLoading(true);
    fetch("/api/deliverability/bulk-tags")
      .then((r) => r.json())
      .then((data) => { if (data.tags) setAllTags(data.tags); })
      .catch(() => setError("Failed to load tags"))
      .finally(() => setLoading(false));
  }, [open]);

  const availableNames = useMemo(() => new Set((availableTags || []).map((t) => t.name)), [availableTags]);
  const tags = useMemo(() => mode === "add" ? allTags : allTags.filter((t) => availableNames.has(t.name)), [mode, allTags, availableNames]);
  const filtered = useMemo(() => {
    if (!search) return tags;
    const q = search.toLowerCase();
    return tags.filter((t) => t.name.toLowerCase().includes(q));
  }, [tags, search]);
  const selectedNames = tags.filter((t) => selectedTagIds.has(t.id)).map((t) => t.name);

  const toggleTag = (id: number) => {
    setSelectedTagIds((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  const handleCreateTag = async () => {
    if (!newTagName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/deliverability/bulk-tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", tagName: newTagName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      const newTag: Tag = data.tag;
      setAllTags((prev) => [...prev, newTag].sort((a, b) => a.name.localeCompare(b.name)));
      setSelectedTagIds((prev) => new Set([...prev, newTag.id]));
      setNewTagName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create tag");
    } finally {
      setCreating(false);
    }
  };

  const handleTagsConfirmed = () => {
    if (selectedTagIds.size === 0) return;
    const ids = Array.from(selectedTagIds);
    const names = tags.filter((t) => selectedTagIds.has(t.id)).map((t) => t.name);
    setSavedTagIds(ids);
    setSavedTagNames(names);

    if (mode === "remove") {
      // Remove mode: close immediately, no campaign step
      onApply({ mode, tagIds: ids, tagNames: names, domains: [...selectedDomains], campaigns: [] });
      onOpenChange(false);
    } else {
      loadCampaignsForTags(names);
    }
  };

  const loadCampaignsForTags = useCallback(async (newTagNames: string[]) => {
    setCampaignsLoading(true);
    setPhase("campaigns");
    try {
      const res = await fetch("/api/campaigns?all=1");
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
  }, [existingTags]);

  const filteredCampaigns = useMemo(() => {
    if (!campaignSearch) return campaigns;
    const q = campaignSearch.toLowerCase();
    return campaigns.filter((c) => c.name.toLowerCase().includes(q));
  }, [campaigns, campaignSearch]);

  const toggleCampaign = (id: number) => {
    setSelectedCampaignIds((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  const transitionToSheet = (camps: { id: number; name: string }[]) => {
    setSavedCampaigns(camps);
    setSheetsLoading(true);
    setPhase("sheet");
    fetch("/api/deliverability/send-to-sheet")
      .then((r) => r.json())
      .then((data) => {
        const sheets: { clientTag: string; sheetName: string }[] = data.sheets || [];
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
    const selectedCamps = campaigns.filter((c) => selectedCampaignIds.has(c.id)).map((c) => ({ id: c.id, name: c.name }));
    transitionToSheet(selectedCamps);
  };

  const handleSkipCampaigns = () => {
    transitionToSheet([]);
  };

  const handleSheetConfirm = () => {
    onApply({ mode, tagIds: savedTagIds, tagNames: savedTagNames, domains: [...selectedDomains], campaigns: savedCampaigns, sheetAppend: selectedSheetTag ? { clientTag: selectedSheetTag } : null });
    onOpenChange(false);
  };

  const handleSheetSkip = () => {
    onApply({ mode, tagIds: savedTagIds, tagNames: savedTagNames, domains: [...selectedDomains], campaigns: savedCampaigns, sheetAppend: null });
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
                <Button size="sm" variant="outline" disabled={!newTagName.trim() || creating} onClick={handleCreateTag}>
                  {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Create"}
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
                {filtered.map((tag) => {
                  const selected = selectedTagIds.has(tag.id);
                  return (
                    <button key={tag.id} onClick={() => toggleTag(tag.id)}
                      className={`flex items-center gap-2.5 w-full px-3 py-2 text-sm text-left transition-colors ${selected ? "bg-primary/10" : "hover:bg-muted/50"}`}>
                      <div className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 transition-colors ${selected ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30"}`}>
                        {selected && <Check className="h-3 w-3" />}
                      </div>
                      <span className="truncate">{tag.name}</span>
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
              <span className="text-xs text-muted-foreground">{selectedTagIds.size} tag{selectedTagIds.size !== 1 ? "s" : ""} selected</span>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
                <Button size="sm" disabled={selectedTagIds.size === 0} onClick={handleTagsConfirmed}
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
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Also add these {selectedDomains.length} domains to a client&apos;s Domains sheet?
            </p>

            {sheetsLoading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : availableSheets.length === 0 ? (
              <div className="text-sm text-muted-foreground py-4">
                No tracked sheets have a &quot;Domains&quot; tab.
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Client Sheet</label>
                  <div className="relative">
                    <select
                      value={selectedSheetTag || ""}
                      onChange={(e) => setSelectedSheetTag(e.target.value)}
                      className="w-full appearance-none rounded-lg border bg-background px-3 py-2 pr-8 text-sm outline-none focus:ring-1 focus:ring-primary"
                    >
                      {availableSheets.map((s) => (
                        <option key={s.clientTag} value={s.clientTag}>
                          {s.clientTag} — {s.sheetName}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                  </div>
                </div>

                {selectedSheetTag && (
                  <div className="text-xs text-muted-foreground rounded-lg border bg-muted/30 px-3 py-2">
                    Target: <span className="font-medium text-foreground">{availableSheets.find((s) => s.clientTag === selectedSheetTag)?.sheetName}</span> &rarr; Domains tab
                  </div>
                )}
              </div>
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
