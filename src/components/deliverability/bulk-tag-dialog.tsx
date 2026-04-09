"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Search, X, Check, Plus, Loader2, CheckCircle2, AlertTriangle } from "lucide-react";

interface Tag { id: number; name: string }

interface Campaign { id: number; name: string; status: string; client_tag: string }

interface BulkTagDialogProps {
  mode: "add" | "remove";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedDomains: string[];
  /** Existing tags on selected domains (collected by parent) */
  existingTags?: string[];
  /** For remove mode: only these tags are shown */
  availableTags?: Tag[];
  /** Called when data should be refreshed (after tags applied or campaigns attached) */
  onSuccess: () => void;
}

type Phase = "tags" | "applying" | "campaigns" | "attaching" | "done";

const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
  paused: "bg-amber-500/10 text-amber-500 border-amber-500/20",
  draft: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
};

export function BulkTagDialog({
  mode, open, onOpenChange, selectedDomains, existingTags, availableTags, onSuccess,
}: BulkTagDialogProps) {
  const [phase, setPhase] = useState<Phase>("tags");
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedTagIds, setSelectedTagIds] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const [newTagName, setNewTagName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tag apply result
  const [tagResult, setTagResult] = useState<{ affected: number } | null>(null);

  // Campaign phase state
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedCampaignIds, setSelectedCampaignIds] = useState<Set<number>>(new Set());
  const [campaignSearch, setCampaignSearch] = useState("");
  const [campaignsLoading, setCampaignsLoading] = useState(false);

  // Attach result
  const [attachResults, setAttachResults] = useState<{ campaign: string; newly: number; existing: number; error?: string }[]>([]);

  // The tag names being applied in this session
  const [appliedTagNames, setAppliedTagNames] = useState<string[]>([]);

  // Reset on open
  useEffect(() => {
    if (!open) return;
    setPhase("tags");
    setSelectedTagIds(new Set());
    setSearch("");
    setNewTagName("");
    setError(null);
    setTagResult(null);
    setCampaigns([]);
    setSelectedCampaignIds(new Set());
    setCampaignSearch("");
    setAttachResults([]);
    setAppliedTagNames([]);

    setLoading(true);
    fetch("/api/deliverability/bulk-tags")
      .then((r) => r.json())
      .then((data) => { if (data.tags) setAllTags(data.tags); })
      .catch(() => setError("Failed to load tags"))
      .finally(() => setLoading(false));
  }, [open]);

  // Tag filtering
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
      if (!res.ok) throw new Error(data.error || "Failed to create tag");
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

  // Apply tags and then transition to campaign phase (add mode) or close (remove mode)
  const handleApplyTags = async () => {
    if (selectedTagIds.size === 0) return;
    const tagNames = tags.filter((t) => selectedTagIds.has(t.id)).map((t) => t.name);
    setAppliedTagNames(tagNames);
    setPhase("applying");
    setError(null);

    try {
      const res = await fetch("/api/deliverability/bulk-tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: mode, tagIds: Array.from(selectedTagIds), domains: selectedDomains }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setTagResult({ affected: data.inboxesAffected || 0 });
      onSuccess();

      if (mode === "add") {
        // Transition to campaign selection
        loadCampaignsForTags(tagNames);
      } else {
        setPhase("done");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
      setPhase("done");
    }
  };

  // Load campaigns matching any of the tag names (existing + newly applied)
  const loadCampaignsForTags = useCallback(async (newTagNames: string[]) => {
    setCampaignsLoading(true);
    setPhase("campaigns");
    try {
      const res = await fetch("/api/campaigns");
      const data = await res.json();
      const allCampaigns: Campaign[] = data.campaigns || (Array.isArray(data) ? data : []);

      // Combine existing tags on selected domains + newly applied tags
      const allRelevantTags = new Set([...(existingTags || []), ...newTagNames]);

      // Filter campaigns whose client_tag matches any relevant tag
      const matching = allCampaigns.filter((c) =>
        c.status !== "archived" && c.status !== "completed" && allRelevantTags.has(c.client_tag)
      );

      setCampaigns(matching);
      // Pre-select all
      setSelectedCampaignIds(new Set(matching.map((c) => c.id)));
    } catch {
      setCampaigns([]);
    } finally {
      setCampaignsLoading(false);
    }
  }, [existingTags]);

  const filteredCampaigns = useMemo(() => {
    if (!campaignSearch) return campaigns;
    const q = campaignSearch.toLowerCase();
    return campaigns.filter((c) => c.name.toLowerCase().includes(q));
  }, [campaigns, campaignSearch]);

  const toggleCampaign = (id: number) => {
    setSelectedCampaignIds((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  // Attach domains to selected campaigns
  const handleAttachCampaigns = async () => {
    if (selectedCampaignIds.size === 0) return;
    setPhase("attaching");
    const selected = campaigns.filter((c) => selectedCampaignIds.has(c.id));
    const results: typeof attachResults = [];

    for (const campaign of selected) {
      try {
        const res = await fetch("/api/deliverability/attach-domains-to-campaign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ campaign_id: campaign.id, domains: selectedDomains }),
        });
        const data = await res.json();
        if (res.ok) {
          results.push({ campaign: campaign.name, newly: data.newly_attached || 0, existing: data.already_attached || 0 });
        } else {
          results.push({ campaign: campaign.name, newly: 0, existing: 0, error: data.error || `HTTP ${res.status}` });
        }
      } catch (e) {
        results.push({ campaign: campaign.name, newly: 0, existing: 0, error: e instanceof Error ? e.message : "Failed" });
      }
      setAttachResults([...results]);
    }
    setPhase("done");
  };

  const handleClose = () => {
    if (phase === "applying" || phase === "attaching") return;
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:!max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {phase === "campaigns" || phase === "attaching"
              ? "Add to Campaigns?"
              : phase === "done" && attachResults.length > 0
                ? "Complete"
                : `${mode === "add" ? "Add Tags" : "Remove Tags"} — ${selectedDomains.length} domain${selectedDomains.length !== 1 ? "s" : ""}`}
          </DialogTitle>
        </DialogHeader>

        {/* ── Phase: Tag Selection ── */}
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
                <Button variant="ghost" size="sm" onClick={handleClose}>Cancel</Button>
                <Button size="sm" disabled={selectedTagIds.size === 0} onClick={handleApplyTags}
                  variant={mode === "remove" ? "destructive" : "default"}>
                  {mode === "add" ? "Add Tags" : "Remove Tags"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ── Phase: Applying Tags ── */}
        {phase === "applying" && (
          <div className="flex flex-col items-center justify-center py-10 gap-3">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">
              {mode === "add" ? "Adding" : "Removing"} tags {mode === "add" ? "to" : "from"} {selectedDomains.length} domains...
            </p>
          </div>
        )}

        {/* ── Phase: Campaign Selection (add mode only) ── */}
        {phase === "campaigns" && (
          <div className="space-y-3 flex-1 overflow-hidden flex flex-col">
            {/* Tag result banner */}
            {tagResult && (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-950/20 px-3 py-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                <span className="text-xs text-emerald-200">Tags added — {tagResult.affected} inboxes updated</span>
              </div>
            )}

            <p className="text-sm text-muted-foreground">
              Also add these {selectedDomains.length} domains to campaigns?
            </p>

            {campaignsLoading ? (
              <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : campaigns.length === 0 ? (
              <div className="text-center py-6 text-sm text-muted-foreground">
                No matching campaigns found for these tags.
              </div>
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
              <Button variant="ghost" size="sm" onClick={() => { setPhase("done"); }}>Skip</Button>
              <Button size="sm" disabled={selectedCampaignIds.size === 0} onClick={handleAttachCampaigns}>
                Attach to {selectedCampaignIds.size} Campaign{selectedCampaignIds.size !== 1 ? "s" : ""}
              </Button>
            </div>
          </div>
        )}

        {/* ── Phase: Attaching to Campaigns ── */}
        {phase === "attaching" && (
          <div className="space-y-3 py-4">
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <span>Attaching domains to campaigns...</span>
              <span className="text-xs text-muted-foreground ml-auto">{attachResults.length}/{campaigns.filter((c) => selectedCampaignIds.has(c.id)).length}</span>
            </div>
            {attachResults.length > 0 && (
              <div className="max-h-40 overflow-y-auto rounded-lg border divide-y">
                {attachResults.map((r, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                    {r.error ? <AlertTriangle className="h-3 w-3 text-destructive shrink-0" /> : <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />}
                    <span className="truncate">{r.campaign}</span>
                    {!r.error && <span className="ml-auto text-muted-foreground shrink-0">+{r.newly} · {r.existing} existing</span>}
                    {r.error && <span className="ml-auto text-destructive shrink-0">{r.error}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Phase: Done ── */}
        {phase === "done" && (
          <div className="space-y-3 py-2">
            {error ? (
              <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-950/20 px-3 py-2">
                <AlertTriangle className="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />
                <span className="text-xs text-red-200">{error}</span>
              </div>
            ) : (
              <>
                {tagResult && (
                  <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-950/20 px-3 py-2">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                    <span className="text-xs text-emerald-200">
                      Tags {mode === "add" ? "added" : "removed"} — {tagResult.affected} inboxes updated
                    </span>
                  </div>
                )}
                {attachResults.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-950/20 px-3 py-2">
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                      <span className="text-xs text-emerald-200">
                        Attached to {attachResults.filter((r) => !r.error).length} campaign{attachResults.filter((r) => !r.error).length !== 1 ? "s" : ""}
                      </span>
                    </div>
                    <div className="max-h-40 overflow-y-auto rounded-lg border divide-y">
                      {attachResults.map((r, i) => (
                        <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                          {r.error ? <AlertTriangle className="h-3 w-3 text-destructive shrink-0" /> : <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />}
                          <span className="truncate">{r.campaign}</span>
                          {!r.error && <span className="ml-auto text-muted-foreground shrink-0">+{r.newly} · {r.existing} existing</span>}
                          {r.error && <span className="ml-auto text-destructive shrink-0">{r.error}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
            <div className="flex justify-end pt-1">
              <Button size="sm" onClick={handleClose}>Close</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
