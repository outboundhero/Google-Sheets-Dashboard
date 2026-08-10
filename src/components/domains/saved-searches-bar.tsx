"use client";

import { useState, useRef, useEffect } from "react";
import { Bookmark, ChevronDown, Trash2, Check, X, Loader2, Plus, Star } from "lucide-react";
import { useDomainSavedSearches, type SavedSearch } from "@/lib/hooks/use-domain-saved-searches";

// Load / save / delete filter presets for a Domains tab's advanced filter
// builder. Server-persisted + team-shared. `snapshot()` serializes the current
// filter state; `onApply` restores a saved one. The scope's default preset (if
// any) is auto-applied once when this bar mounts (i.e. on entering the tab).
export function SavedSearchesBar({ scope, snapshot, onApply }: {
  scope: "all-domains" | "purchased";
  snapshot: () => Record<string, unknown>;
  onApply: (filter: Record<string, unknown>) => void;
}) {
  const { searches, isLoading, mutate } = useDomainSavedSearches(scope);
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeName, setActiveName] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close the dropdown on outside click.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // Auto-apply the scope's default preset once, on mount / first load.
  const appliedDefaultRef = useRef(false);
  useEffect(() => {
    if (appliedDefaultRef.current || isLoading) return;
    appliedDefaultRef.current = true;
    const def = searches.find((s) => s.isDefault);
    if (def) { onApply(def.filter || {}); setActiveName(def.name); }
  }, [isLoading, searches, onApply]);

  const apply = (s: SavedSearch) => { onApply(s.filter || {}); setActiveName(s.name); setOpen(false); };

  const toggleDefault = async (s: SavedSearch) => {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/domains/saved-searches", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, id: s.isDefault ? null : s.id }),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d?.error || `HTTP ${res.status}`); }
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally { setBusy(false); }
  };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/domains/saved-searches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, name: trimmed, filter: snapshot() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      await mutate();
      setActiveName(trimmed);
      setNaming(false); setName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally { setBusy(false); }
  };

  const remove = async (s: SavedSearch) => {
    if (!confirm(`Delete saved search "${s.name}"?`)) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/domains/saved-searches?id=${encodeURIComponent(s.id)}`, { method: "DELETE" });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d?.error || `HTTP ${res.status}`); }
      if (activeName === s.name) setActiveName(null);
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally { setBusy(false); }
  };

  return (
    <div ref={wrapRef} className="relative flex flex-wrap items-center gap-2">
      {/* Load dropdown */}
      <div className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1.5 text-xs font-medium hover:bg-muted/40"
        >
          <Bookmark className="h-3.5 w-3.5 text-muted-foreground" />
          {activeName || "Saved searches"}
          {searches.length > 0 && <span className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">{searches.length}</span>}
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
        {open && (
          <div className="absolute z-40 mt-1 w-64 rounded-lg border bg-card shadow-lg overflow-hidden">
            {searches.length === 0 ? (
              <div className="px-3 py-3 text-[11px] text-muted-foreground">No saved searches yet — set your filters and click Save.</div>
            ) : (
              <div className="max-h-72 overflow-y-auto py-1">
                {searches.map((s) => (
                  <div key={s.id} className="group flex items-center gap-1.5 px-2 py-1.5 hover:bg-muted/40">
                    <button
                      onClick={() => toggleDefault(s)}
                      disabled={busy}
                      className={`shrink-0 ${s.isDefault ? "text-amber-500" : "text-muted-foreground/40 opacity-0 group-hover:opacity-100 hover:text-amber-500"}`}
                      title={s.isDefault ? "Default — auto-applies when you open this tab (click to unset)" : "Set as default (auto-apply on open)"}
                    >
                      <Star className={`h-3.5 w-3.5 ${s.isDefault ? "fill-amber-500" : ""}`} />
                    </button>
                    <button onClick={() => apply(s)} className="flex-1 min-w-0 text-left text-xs truncate" title={s.name}>{s.name}</button>
                    <button onClick={() => remove(s)} className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0" title="Delete">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Save current */}
      {naming ? (
        <div className="flex items-center gap-1">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") { setNaming(false); setName(""); } }}
            placeholder="Name this search…"
            className="text-xs rounded-lg border bg-background px-2 py-1.5 outline-none focus:ring-1 focus:ring-primary w-44"
          />
          <button onClick={save} disabled={busy || !name.trim()} className="rounded-md border border-primary/40 text-primary p-1 hover:bg-primary/10 disabled:opacity-40" title="Save">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          </button>
          <button onClick={() => { setNaming(false); setName(""); setError(null); }} className="rounded-md border p-1 text-muted-foreground hover:bg-muted/40" title="Cancel">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <button onClick={() => setNaming(true)} className="flex items-center gap-1 rounded-lg border bg-card px-2.5 py-1.5 text-xs font-medium hover:bg-muted/40">
          <Plus className="h-3.5 w-3.5 text-muted-foreground" /> Save current
        </button>
      )}

      {error && <span className="text-[11px] text-destructive">{error}</span>}
    </div>
  );
}
