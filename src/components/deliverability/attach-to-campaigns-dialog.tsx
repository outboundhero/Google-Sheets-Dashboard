"use client";

import { useState, useEffect, useMemo } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, X, Check } from "lucide-react";
import { useInstance } from "@/lib/instance-context";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedDomains: string[];
  /** Called with the selected campaigns when user clicks Attach — parent handles the actual work */
  onAttach: (
    campaigns: { id: number; name: string; instance: BisonInstanceSlug }[],
    domains: string[],
  ) => void;
}

interface Campaign {
  id: number;
  instance: BisonInstanceSlug;
  name: string;
  status: string;
  client_tag: string;
}

const ALLOWED_STATUSES = ["active", "paused", "draft"];

const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
  paused: "bg-amber-500/10 text-amber-500 border-amber-500/20",
  draft: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
};

export function AttachToCampaignsDialog({ open, onOpenChange, selectedDomains, onAttach }: Props) {
  const { instancesQuery } = useInstance();
  const [phase, setPhase] = useState<"select-tag" | "select-campaigns">("select-tag");
  const [clientTags, setClientTags] = useState<string[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedTag, setSelectedTag] = useState("");
  const [selectedCampaignIds, setSelectedCampaignIds] = useState<Set<number>>(new Set());
  const [tagSearch, setTagSearch] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPhase("select-tag");
    setSelectedTag("");
    setSelectedCampaignIds(new Set());
    setTagSearch("");

    setLoading(true);
    fetch(`/api/campaigns?all=1&${instancesQuery}`)
      .then((r) => r.json())
      .then((data) => {
        const camps: Campaign[] = data.campaigns || (Array.isArray(data) ? data : []);
        setCampaigns(camps);
        const tags = new Set<string>();
        for (const c of camps) {
          if (c.client_tag && ALLOWED_STATUSES.includes(c.status.toLowerCase())) tags.add(c.client_tag);
        }
        setClientTags(Array.from(tags).sort());
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [open, instancesQuery]);

  const matchingCampaigns = useMemo(() => {
    if (!selectedTag) return [];
    return campaigns
      .filter((c) => c.client_tag === selectedTag && ALLOWED_STATUSES.includes(c.status.toLowerCase()))
      .sort((a, b) => {
        const order: Record<string, number> = { active: 0, draft: 1, paused: 2 };
        return (order[a.status.toLowerCase()] ?? 3) - (order[b.status.toLowerCase()] ?? 3);
      });
  }, [campaigns, selectedTag]);

  const filteredTags = useMemo(() => {
    if (!tagSearch) return clientTags;
    const q = tagSearch.toLowerCase();
    return clientTags.filter((t) => t.toLowerCase().includes(q));
  }, [clientTags, tagSearch]);

  const selectedCampaigns = useMemo(() => {
    return matchingCampaigns.filter((c) => selectedCampaignIds.has(c.id));
  }, [matchingCampaigns, selectedCampaignIds]);

  const handleTagSelect = (tag: string) => {
    setSelectedTag(tag);
    const ids = campaigns
      .filter((c) => c.client_tag === tag && ALLOWED_STATUSES.includes(c.status.toLowerCase()))
      .map((c) => c.id);
    setSelectedCampaignIds(new Set(ids));
    setPhase("select-campaigns");
  };

  const toggleCampaign = (id: number) => {
    setSelectedCampaignIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedCampaignIds.size === matchingCampaigns.length) {
      setSelectedCampaignIds(new Set());
    } else {
      setSelectedCampaignIds(new Set(matchingCampaigns.map((c) => c.id)));
    }
  };

  const handleStart = () => {
    // Pass selected campaigns + domains to parent, close dialog immediately
    onAttach(
      selectedCampaigns.map((c) => ({ id: c.id, name: c.name, instance: c.instance })),
      [...selectedDomains]
    );
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:!max-w-xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Attach to Campaigns</DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">
            {selectedDomains.length} domain{selectedDomains.length !== 1 ? "s" : ""} selected
          </p>
        </DialogHeader>

        {phase === "select-tag" && (
          <div className="space-y-3 mt-2 flex-1 overflow-hidden flex flex-col">
            <p className="text-sm text-muted-foreground">Select a client tag:</p>
            <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-1.5">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input value={tagSearch} onChange={(e) => setTagSearch(e.target.value)} placeholder="Search client tags..." className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground" />
              {tagSearch && <button onClick={() => setTagSearch("")}><X className="h-3 w-3 text-muted-foreground hover:text-foreground" /></button>}
            </div>
            {loading ? (
              <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : (
              <div className="flex-1 overflow-y-auto rounded-lg border divide-y">
                {filteredTags.map((tag) => {
                  const count = campaigns.filter((c) => c.client_tag === tag && ALLOWED_STATUSES.includes(c.status.toLowerCase())).length;
                  return (
                    <button key={tag} onClick={() => handleTagSelect(tag)} className="flex items-center justify-between w-full px-3 py-2 text-sm hover:bg-muted/50 transition-colors">
                      <span className="font-medium">{tag}</span>
                      <span className="text-xs text-muted-foreground">{count} campaign{count !== 1 ? "s" : ""}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {phase === "select-campaigns" && (
          <div className="space-y-3 mt-2 flex-1 overflow-hidden flex flex-col">
            <div className="flex items-center justify-between">
              <div>
                <button onClick={() => { setPhase("select-tag"); setSelectedTag(""); }} className="text-xs text-muted-foreground hover:text-foreground">
                  ← Back
                </button>
                <p className="text-sm font-medium mt-1">{selectedTag} — {matchingCampaigns.length} campaigns</p>
              </div>
              <button onClick={toggleAll} className="text-xs text-primary hover:underline">
                {selectedCampaignIds.size === matchingCampaigns.length ? "Deselect all" : "Select all"}
              </button>
            </div>

            <div className="flex-1 overflow-y-auto rounded-lg border divide-y">
              {matchingCampaigns.map((c) => {
                const selected = selectedCampaignIds.has(c.id);
                return (
                  <button key={c.id} onClick={() => toggleCampaign(c.id)} className={`flex items-center gap-3 w-full px-3 py-2.5 text-sm transition-colors ${selected ? "bg-primary/5" : "hover:bg-muted/50"}`}>
                    <div className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 transition-colors ${selected ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30"}`}>
                      {selected && <Check className="h-3 w-3" />}
                    </div>
                    <span className="truncate flex-1 text-left">{c.name}</span>
                    <Badge variant="outline" className={`text-[9px] px-1.5 py-0 shrink-0 ${STATUS_COLORS[c.status.toLowerCase()] || ""}`}>{c.status}</Badge>
                  </button>
                );
              })}
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button size="sm" disabled={selectedCampaigns.length === 0} onClick={handleStart}>
                Attach to {selectedCampaigns.length} Campaign{selectedCampaigns.length !== 1 ? "s" : ""}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
