"use client";

import { useState, useEffect, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Search, X, Check, Plus, Loader2 } from "lucide-react";

interface Tag {
  id: number;
  name: string;
}

interface BulkTagDialogProps {
  mode: "add" | "remove";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedDomains: string[];
  /** For remove mode: only these tags are shown (tags present on selected domains) */
  availableTags?: Tag[];
  onSuccess: () => void;
}

export function BulkTagDialog({
  mode,
  open,
  onOpenChange,
  selectedDomains,
  availableTags,
  onSuccess,
}: BulkTagDialogProps) {
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [selectedTagIds, setSelectedTagIds] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const [newTagName, setNewTagName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ inboxesAffected: number } | null>(null);

  // Fetch all tags for "add" mode
  useEffect(() => {
    if (!open) return;
    setSelectedTagIds(new Set());
    setSearch("");
    setNewTagName("");
    setError(null);
    setResult(null);

    setLoading(true);
    fetch("/api/deliverability/bulk-tags")
      .then((r) => r.json())
      .then((data) => {
        if (data.tags) setAllTags(data.tags);
      })
      .catch(() => setError("Failed to load tags"))
      .finally(() => setLoading(false));
  }, [open]);

  // For "remove" mode, filter to only tags present on selected domains
  const availableNames = useMemo(
    () => new Set((availableTags || []).map((t) => t.name)),
    [availableTags]
  );
  const tags = useMemo(() => {
    if (mode === "add") return allTags;
    return allTags.filter((t) => availableNames.has(t.name));
  }, [mode, allTags, availableNames]);

  const filtered = useMemo(() => {
    if (!search) return tags;
    const q = search.toLowerCase();
    return tags.filter((t) => t.name.toLowerCase().includes(q));
  }, [tags, search]);

  const toggleTag = (id: number) => {
    setSelectedTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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

  const handleApply = async () => {
    if (selectedTagIds.size === 0) return;
    setApplying(true);
    setError(null);
    try {
      const res = await fetch("/api/deliverability/bulk-tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: mode,
          tagIds: Array.from(selectedTagIds),
          domains: selectedDomains,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setResult({ inboxesAffected: data.inboxesAffected });
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setApplying(false);
    }
  };

  const selectedNames = tags
    .filter((t) => selectedTagIds.has(t.id))
    .map((t) => t.name);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === "add" ? "Add Tags" : "Remove Tags"} — {selectedDomains.length} domain
            {selectedDomains.length !== 1 ? "s" : ""}
          </DialogTitle>
        </DialogHeader>

        {result ? (
          <div className="py-6 text-center space-y-2">
            <div className="text-emerald-500 font-medium">
              {mode === "add" ? "Tags added" : "Tags removed"} successfully
            </div>
            <div className="text-sm text-muted-foreground">
              {result.inboxesAffected} inbox{result.inboxesAffected !== 1 ? "es" : ""} updated
            </div>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Create new tag (add mode only) */}
            {mode === "add" && (
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-1.5 flex-1">
                  <Plus className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <input
                    value={newTagName}
                    onChange={(e) => setNewTagName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleCreateTag()}
                    placeholder="Create new tag…"
                    className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
                  />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!newTagName.trim() || creating}
                  onClick={handleCreateTag}
                >
                  {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Create"}
                </Button>
              </div>
            )}

            {/* Search */}
            <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-1.5">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search tags…"
                className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
              />
              {search && (
                <button onClick={() => setSearch("")}>
                  <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                </button>
              )}
            </div>

            {/* Tag list */}
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-6 text-sm text-muted-foreground">
                {search ? "No tags match your search" : "No tags available"}
              </div>
            ) : (
              <div className="max-h-60 overflow-y-auto rounded-lg border divide-y">
                {filtered.map((tag) => {
                  const selected = selectedTagIds.has(tag.id);
                  return (
                    <button
                      key={tag.id}
                      onClick={() => toggleTag(tag.id)}
                      className={`flex items-center gap-2.5 w-full px-3 py-2 text-sm text-left transition-colors ${
                        selected ? "bg-primary/10" : "hover:bg-muted/50"
                      }`}
                    >
                      <div
                        className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                          selected
                            ? "bg-primary border-primary text-primary-foreground"
                            : "border-muted-foreground/30"
                        }`}
                      >
                        {selected && <Check className="h-3 w-3" />}
                      </div>
                      <span className="truncate">{tag.name}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Selected tags summary */}
            {selectedNames.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {selectedNames.map((name) => (
                  <span
                    key={name}
                    className="text-[10px] bg-primary/10 text-primary border border-primary/20 rounded-full px-2 py-0.5"
                  >
                    {name}
                  </span>
                ))}
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="text-xs text-destructive">{error}</div>
            )}

            {/* Actions */}
            <div className="flex items-center justify-between pt-1">
              <span className="text-xs text-muted-foreground">
                {selectedTagIds.size} tag{selectedTagIds.size !== 1 ? "s" : ""} selected
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={selectedTagIds.size === 0 || applying}
                  onClick={handleApply}
                  variant={mode === "remove" ? "destructive" : "default"}
                >
                  {applying ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                  ) : null}
                  {mode === "add" ? "Add Tags" : "Remove Tags"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
