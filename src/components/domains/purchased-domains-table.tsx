"use client";

import { useMemo, useState, useRef, useEffect, useCallback } from "react";
import { Globe, Search, X, RefreshCw, Loader2, ShoppingBag, Check, RotateCw, EyeOff, Eye, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePurchasedDomains, type PurchasedRow } from "@/lib/hooks/use-purchased-domains";
import { useAuth } from "@/lib/auth-context";
import { useDomainOps } from "./domain-ops-context";
import { DomainFilterBuilder, applyFilters, type FilterField, type FilterCondition, type FilterMode } from "./domain-filter-builder";

const PROVIDER_BADGE: Record<string, string> = {
  google: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  outlook: "bg-sky-500/10 text-sky-600 border-sky-500/20",
  mixed: "bg-violet-500/10 text-violet-600 border-violet-500/20",
  zoho: "bg-orange-500/10 text-orange-600 border-orange-500/20",
  porkbun: "bg-rose-500/10 text-rose-600 border-rose-500/20",
  other: "bg-muted text-muted-foreground border-border",
  parked: "bg-muted text-muted-foreground border-border",
  "no-dns": "bg-muted text-muted-foreground border-border",
  unknown: "bg-muted text-muted-foreground border-border",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

export function PurchasedDomainsTable() {
  const { role } = useAuth();
  const isAdmin = role === "admin";
  const { rows, counts, isLoading, mutate } = usePurchasedDomains();
  const { runAutoRenew, runHide } = useDomainOps();
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [conditions, setConditions] = useState<FilterCondition[]>([]);
  const [filterMode, setFilterMode] = useState<FilterMode>("AND");
  const [hiddenOpen, setHiddenOpen] = useState(false);

  const sources = useMemo(() => Array.from(new Set(rows.map((r) => r.source))).sort(), [rows]);
  const providers = useMemo(() => Array.from(new Set(rows.map((r) => r.provider))).sort(), [rows]);

  const filterFields = useMemo<FilterField<PurchasedRow>[]>(() => [
    { key: "domain", label: "Domain", type: "text", get: (r) => r.domain },
    { key: "source", label: "Source", type: "enum", options: sources.map((s) => [s, s.replace("porkbun_", "")] as [string, string]), get: (r) => r.source },
    { key: "provider", label: "Provider", type: "enum", options: providers.map((p) => [p, p] as [string, string]), get: (r) => r.provider },
    { key: "inUse", label: "In use", type: "bool", get: (r) => r.inUse },
    { key: "renewalDate", label: "Renewal date", type: "date", get: (r) => r.renewalDate },
    { key: "autoRenew", label: "Auto-renew", type: "bool", get: (r) => !!r.autoRenew },
    { key: "hidden", label: "Hidden", type: "bool", get: (r) => !!r.hidden },
    { key: "surbl", label: "SURBL listed", type: "bool", get: (r) => !!r.surblListed },
    { key: "spamhaus", label: "Spamhaus listed", type: "bool", get: (r) => !!r.spamhausListed },
  ], [sources, providers]);

  const matched = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = q ? rows.filter((r) => r.domain.toLowerCase().includes(q)) : rows;
    out = applyFilters(out, conditions, filterMode, filterFields);
    return [...out].sort((a, b) => (b.purchasedAt || "").localeCompare(a.purchasedAt || ""));
  }, [rows, search, conditions, filterMode, filterFields]);

  const nonHidden = useMemo(() => matched.filter((r) => !r.hidden), [matched]);
  const hiddenRows = useMemo(() => matched.filter((r) => r.hidden), [matched]);
  const clearAllFilters = () => { setSearch(""); setConditions([]); };

  // ── Bulk selection (click + drag) ──────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const dragging = useRef(false);
  const dragAdd = useRef(true);
  useEffect(() => {
    const up = () => { dragging.current = false; };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);
  const applyDrag = useCallback((d: string) => setSelected((s) => {
    const n = new Set(s);
    if (dragAdd.current) n.add(d); else n.delete(d);
    return n;
  }), []);
  const startDrag = useCallback((d: string) => {
    dragging.current = true;
    dragAdd.current = !selected.has(d);
    applyDrag(d);
  }, [selected, applyDrag]);
  const allSelected = matched.length > 0 && matched.every((r) => selected.has(r.domain));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(matched.map((r) => r.domain)));
  const selectedList = useMemo(() => Array.from(selected), [selected]);

  const refresh = async () => {
    setRefreshing(true);
    try { await mutate(); } finally { setRefreshing(false); }
  };

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="rounded-xl border bg-card p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2">
            <ShoppingBag className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">Purchased domains</h2>
            <span className="text-xs text-muted-foreground">bought through the Buy page</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="flex items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 w-56">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search domains…"
                className="flex-1 text-xs bg-transparent outline-none placeholder:text-muted-foreground"
              />
              {search && <button onClick={() => setSearch("")}><X className="h-3 w-3 text-muted-foreground hover:text-foreground" /></button>}
            </div>
            <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" onClick={refresh} disabled={refreshing}>
              {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <Chip>{counts?.total ?? rows.length} purchased</Chip>
          <Chip accent="emerald">${(counts?.totalSpent ?? 0).toFixed(2)} spent</Chip>
          {(search || conditions.length > 0) && (
            <button onClick={clearAllFilters} className="ml-auto flex items-center gap-1 text-muted-foreground hover:text-foreground">
              <X className="h-3 w-3" /> Clear filters
            </button>
          )}
        </div>
      </div>

      {/* Advanced filter builder */}
      <DomainFilterBuilder fields={filterFields} conditions={conditions} setConditions={setConditions} mode={filterMode} setMode={setFilterMode} />

      {/* Selection action bar */}
      {isAdmin && selected.size > 0 && (
        <div className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card/95 backdrop-blur px-4 py-2.5 shadow-sm">
          <span className="text-xs font-medium">{selected.size} selected</span>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={() => { runAutoRenew(selectedList, true); setSelected(new Set()); }}>
              <RotateCw className="h-3 w-3" /> Auto-renew ON
            </Button>
            <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={() => { runAutoRenew(selectedList, false); setSelected(new Set()); }}>
              <RotateCw className="h-3 w-3" /> Auto-renew OFF
            </Button>
            <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={() => { runHide(selectedList, true); setSelected(new Set()); }}>
              <EyeOff className="h-3 w-3" /> Hide
            </Button>
            <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={() => { runHide(selectedList, false); setSelected(new Set()); }}>
              <Eye className="h-3 w-3" /> Unhide
            </Button>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSelected(new Set())}>Clear</Button>
          </div>
        </div>
      )}

      {/* Table (non-hidden) */}
      <div className="rounded-xl border bg-card overflow-hidden">
        {isLoading && rows.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-12">Loading…</div>
        ) : matched.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-12">
            {rows.length === 0 ? "No purchased domains yet — buy some from the Buy tab." : "No domains match your filters."}
          </div>
        ) : nonHidden.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-12">All matching domains are hidden — see the Hidden section below.</div>
        ) : (
          <div className="overflow-x-auto select-none">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] text-muted-foreground border-b">
                  <th className="w-[36px] px-3 py-2.5">
                    <button
                      onClick={toggleAll}
                      className={`h-4 w-4 rounded border flex items-center justify-center transition-colors ${allSelected ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30 hover:border-foreground"}`}
                      title="Select all"
                    >
                      {allSelected && <Check className="h-3 w-3" />}
                    </button>
                  </th>
                  <th className="text-left font-medium px-3 py-2.5">Domain</th>
                  <th className="text-right font-medium px-3 py-2.5 w-[110px]">Price paid</th>
                  <th className="text-right font-medium px-3 py-2.5 w-[130px]">Purchased</th>
                  <th className="text-right font-medium px-3 py-2.5 w-[130px]">Renewal</th>
                  <th className="text-left font-medium px-3 py-2.5 w-[100px]">In use</th>
                  <th className="text-left font-medium px-3 py-2.5 w-[130px]">Provider</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {nonHidden.map((r) => (
                  <Row
                    key={r.domain}
                    r={r}
                    selected={selected.has(r.domain)}
                    onMouseDown={() => startDrag(r.domain)}
                    onMouseEnter={() => { if (dragging.current) applyDrag(r.domain); }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Hidden domains (collapsible) */}
      {hiddenRows.length > 0 && (
        <div className="rounded-xl border bg-card overflow-hidden">
          <button
            onClick={() => setHiddenOpen((v) => !v)}
            className="flex w-full items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/30 transition-colors"
          >
            {hiddenOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            <EyeOff className="h-4 w-4 text-muted-foreground" />
            Hidden domains
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{hiddenRows.length}</span>
          </button>
          {hiddenOpen && (
            <div className="overflow-x-auto select-none border-t">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] text-muted-foreground border-b">
                    <th className="w-[36px] px-3 py-2.5" />
                    <th className="text-left font-medium px-3 py-2.5">Domain</th>
                    <th className="text-right font-medium px-3 py-2.5 w-[110px]">Price paid</th>
                    <th className="text-right font-medium px-3 py-2.5 w-[130px]">Purchased</th>
                    <th className="text-right font-medium px-3 py-2.5 w-[130px]">Renewal</th>
                    <th className="text-left font-medium px-3 py-2.5 w-[100px]">In use</th>
                    <th className="text-left font-medium px-3 py-2.5 w-[130px]">Provider</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {hiddenRows.map((r) => (
                    <Row
                      key={r.domain}
                      r={r}
                      selected={selected.has(r.domain)}
                      onMouseDown={() => startDrag(r.domain)}
                      onMouseEnter={() => { if (dragging.current) applyDrag(r.domain); }}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ r, selected, onMouseDown, onMouseEnter }: {
  r: PurchasedRow; selected: boolean; onMouseDown: () => void; onMouseEnter: () => void;
}) {
  return (
    <tr
      className={`transition-colors cursor-pointer ${selected ? "bg-primary/5" : "hover:bg-muted/30"}`}
      onMouseDown={onMouseDown}
      onMouseEnter={onMouseEnter}
    >
      <td className="px-3 py-2.5">
        <div className={`h-4 w-4 rounded border flex items-center justify-center transition-colors ${selected ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30"}`}>
          {selected && <Check className="h-3 w-3" />}
        </div>
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="font-medium select-text cursor-text">{r.domain}</span>
        </div>
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-violet-500 font-medium">
        {r.pricePaid != null ? `$${r.pricePaid.toFixed(2)}` : "—"}
      </td>
      <td className="px-3 py-2.5 text-right text-xs text-muted-foreground tabular-nums">{fmtDate(r.purchasedAt)}</td>
      <td className="px-3 py-2.5 text-right text-xs text-muted-foreground tabular-nums">{fmtDate(r.renewalDate)}</td>
      <td className="px-3 py-2.5">
        {r.inUse ? (
          <span className="inline-flex items-center rounded-md border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600">In use</span>
        ) : (
          <span className="text-[10px] text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-3 py-2.5">
        <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${PROVIDER_BADGE[r.provider] || PROVIDER_BADGE.unknown}`}>
          {r.provider}
        </span>
      </td>
    </tr>
  );
}

function Chip({ children, accent }: { children: React.ReactNode; accent?: "emerald" }) {
  return (
    <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-medium ${accent === "emerald" ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-600" : "bg-muted/40 text-muted-foreground border-border"}`}>
      {children}
    </span>
  );
}
