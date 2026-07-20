"use client";

import { useMemo, useState } from "react";
import { Globe, Search, X, RefreshCw, Loader2, ArrowUpDown, Signal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { useDomainInventory, type InventoryRow } from "@/lib/hooks/use-domain-inventory";
import { ImportDomainsDialog } from "./import-domains-dialog";
import { useInventory } from "./inventory-context";

const PAGE_SIZE = 100;

type SortKey = "domain" | "source" | "inUse" | "provider" | "expireDate";

const PROVIDER_BADGE: Record<string, string> = {
  google: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  outlook: "bg-sky-500/10 text-sky-600 border-sky-500/20",
  mixed: "bg-violet-500/10 text-violet-600 border-violet-500/20",
  zoho: "bg-orange-500/10 text-orange-600 border-orange-500/20",
  other: "bg-muted text-muted-foreground border-border",
  parked: "bg-muted text-muted-foreground border-border",
  unknown: "bg-muted text-muted-foreground border-border",
};

const SOURCE_BADGE: Record<string, string> = {
  porkbun_outboundhero: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
  porkbun_spencersellstech: "bg-amber-500/10 text-amber-600 border-amber-500/20",
  manual: "bg-primary/10 text-primary border-primary/20",
};

export function AllDomainsTable() {
  const { role } = useAuth();
  const isAdmin = role === "admin";
  const { rows, counts, generatedAt, isLoading, mutate } = useDomainInventory();
  // Sync + MX-resolve live above the tabs (persist across tab switches).
  const { syncing, syncMsg, mxRemaining, mxRunning, mxResolved, mxFailed, mxNote, refreshPorkbun, resolveProviders } = useInventory();

  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [inUseFilter, setInUseFilter] = useState("all");
  const [providerFilter, setProviderFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("domain");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(0);

  const sources = useMemo(() => Object.keys(counts?.bySource || {}).sort(), [counts]);
  const providers = useMemo(() => Object.keys(counts?.byProvider || {}).sort(), [counts]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = rows.filter((r) => {
      if (q && !r.domain.toLowerCase().includes(q)) return false;
      if (sourceFilter !== "all" && r.source !== sourceFilter) return false;
      if (inUseFilter === "in" && !r.inUse) return false;
      if (inUseFilter === "out" && r.inUse) return false;
      if (providerFilter !== "all" && r.provider !== providerFilter) return false;
      return true;
    });
    out = [...out].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "domain") cmp = a.domain.localeCompare(b.domain);
      else if (sortKey === "source") cmp = a.source.localeCompare(b.source);
      else if (sortKey === "inUse") cmp = Number(a.inUse) - Number(b.inUse);
      else if (sortKey === "provider") cmp = a.provider.localeCompare(b.provider);
      else if (sortKey === "expireDate") cmp = (a.expireDate || "").localeCompare(b.expireDate || "");
      return sortDir === "asc" ? cmp : -cmp;
    });
    return out;
  }, [rows, search, sourceFilter, inUseFilter, providerFilter, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
    setPage(0);
  };
  // Reset to the first page whenever a filter/search changes.
  const withReset = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); setPage(0); };

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="rounded-xl border bg-card p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 w-56">
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              placeholder="Search domains…"
              className="flex-1 text-xs bg-transparent outline-none placeholder:text-muted-foreground"
            />
            {search && <button onClick={() => { setSearch(""); setPage(0); }}><X className="h-3 w-3 text-muted-foreground hover:text-foreground" /></button>}
          </div>

          <FilterSelect value={sourceFilter} onChange={withReset(setSourceFilter)} label="Source" options={[["all", "All sources"], ...sources.map((s) => [s, s] as [string, string])]} />
          <FilterSelect value={inUseFilter} onChange={withReset(setInUseFilter)} label="In use" options={[["all", "All"], ["in", "In use"], ["out", "Not in use"]]} />
          <FilterSelect value={providerFilter} onChange={withReset(setProviderFilter)} label="Provider" options={[["all", "All providers"], ...providers.map((p) => [p, p] as [string, string])]} />

          <div className="ml-auto flex items-center gap-2">
            {isAdmin && <ImportDomainsDialog onImported={mutate} />}
            {isAdmin && mxRemaining != null && mxRemaining > 0 && (
              <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" onClick={resolveProviders} disabled={mxRunning}>
                {mxRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Signal className="h-3.5 w-3.5" />}
                {mxRunning ? "Resolving…" : `Resolve ${mxRemaining} providers`}
              </Button>
            )}
            {isAdmin && (
              <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" onClick={refreshPorkbun} disabled={syncing}>
                {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Refresh Porkbun
              </Button>
            )}
          </div>
        </div>

        {/* Count chips */}
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <Chip>{counts?.total ?? rows.length} total</Chip>
          <Chip accent="emerald">{counts?.inUse ?? 0} in use</Chip>
          <Chip>{counts?.notInUse ?? 0} not in use</Chip>
          {sources.map((s) => <Chip key={s}>{s.replace("porkbun_", "")}: {counts?.bySource[s] ?? 0}</Chip>)}
          {mxRemaining != null && mxRemaining > 0 && (
            mxRunning ? (
              <span className="flex items-center gap-1 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> resolving · {mxResolved} done{mxFailed > 0 ? ` · ${mxFailed} failed` : ""} · {mxRemaining} left
              </span>
            ) : (
              <span className={mxFailed > 0 ? "text-amber-500" : "text-muted-foreground"}>
                {mxRemaining} providers unresolved{mxResolved > 0 || mxFailed > 0 ? ` (${mxResolved} done, ${mxFailed} failed last run)` : ""}
              </span>
            )
          )}
          {generatedAt && <span className="text-muted-foreground ml-auto">updated {new Date(generatedAt).toLocaleTimeString()}</span>}
        </div>

        {mxNote && <div className="text-xs text-amber-500 border-t pt-2">{mxNote}</div>}
        {syncMsg && <div className="text-xs text-muted-foreground border-t pt-2">{syncMsg}</div>}
      </div>

      {/* Table */}
      <div className="rounded-xl border bg-card overflow-hidden">
        {isLoading && rows.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-12">Loading inventory…</div>
        ) : filtered.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-12">
            {rows.length === 0 ? "No domains yet — click Refresh Porkbun or Import domains." : "No domains match your filters."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] text-muted-foreground border-b">
                  <SortableTh label="Domain" k="domain" sortKey={sortKey} onClick={toggleSort} className="text-left" />
                  <SortableTh label="Source" k="source" sortKey={sortKey} onClick={toggleSort} className="text-left w-[190px]" />
                  <SortableTh label="In use" k="inUse" sortKey={sortKey} onClick={toggleSort} className="text-left w-[100px]" />
                  <SortableTh label="Provider" k="provider" sortKey={sortKey} onClick={toggleSort} className="text-left w-[130px]" />
                  <SortableTh label="Expiry" k="expireDate" sortKey={sortKey} onClick={toggleSort} className="text-right w-[130px]" />
                  <th className="text-right font-medium px-3 py-2.5 w-[90px]">Auto-renew</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {pageRows.map((r) => <Row key={r.domain} r={r} />)}
              </tbody>
            </table>
          </div>
        )}

        {filtered.length > PAGE_SIZE && (
          <div className="flex items-center justify-between px-4 py-2.5 border-t text-xs text-muted-foreground">
            <span>{safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}</span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="h-7 text-xs" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>Prev</Button>
              <span className="tabular-nums">{safePage + 1} / {pageCount}</span>
              <Button variant="outline" size="sm" className="h-7 text-xs" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>Next</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ r }: { r: InventoryRow }) {
  return (
    <tr className="hover:bg-muted/30 transition-colors">
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="font-medium">{r.domain}</span>
        </div>
      </td>
      <td className="px-3 py-2.5">
        <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${SOURCE_BADGE[r.source] || "bg-muted text-muted-foreground border-border"}`}>
          {r.sourceLabel}
        </span>
      </td>
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
        {r.providerSource === "mx" && <span className="ml-1 text-[9px] text-muted-foreground" title="from DNS MX records">mx</span>}
      </td>
      <td className="px-3 py-2.5 text-right text-xs text-muted-foreground tabular-nums">
        {r.expireDate ? new Date(r.expireDate).toLocaleDateString() : "—"}
      </td>
      <td className="px-3 py-2.5 text-right text-xs">
        {r.autoRenew == null ? <span className="text-muted-foreground">—</span> : r.autoRenew ? <span className="text-amber-500">on</span> : <span className="text-muted-foreground">off</span>}
      </td>
    </tr>
  );
}

function SortableTh({ label, k, sortKey, onClick, className }: {
  label: string; k: SortKey; sortKey: SortKey; onClick: (k: SortKey) => void; className?: string;
}) {
  return (
    <th className={`font-medium px-3 py-2.5 ${className || ""}`}>
      <button onClick={() => onClick(k)} className="inline-flex items-center gap-1 hover:text-foreground">
        {label}
        <ArrowUpDown className={`h-3 w-3 ${sortKey === k ? "text-foreground" : "text-muted-foreground/40"}`} />
      </button>
    </th>
  );
}

function FilterSelect({ value, onChange, label, options }: {
  value: string; onChange: (v: string) => void; label: string; options: [string, string][];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="text-xs rounded-lg border bg-background px-2.5 py-1.5 outline-none focus:ring-1 focus:ring-primary"
      aria-label={label}
    >
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

function Chip({ children, accent }: { children: React.ReactNode; accent?: "emerald" }) {
  return (
    <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-medium ${accent === "emerald" ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-600" : "bg-muted/40 text-muted-foreground border-border"}`}>
      {children}
    </span>
  );
}
