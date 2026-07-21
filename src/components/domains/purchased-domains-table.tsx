"use client";

import { useMemo, useState } from "react";
import { Globe, Search, X, RefreshCw, Loader2, ShoppingBag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePurchasedDomains, type PurchasedRow } from "@/lib/hooks/use-purchased-domains";

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
  const { rows, counts, isLoading, mutate } = usePurchasedDomains();
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = q ? rows.filter((r) => r.domain.toLowerCase().includes(q)) : rows;
    return [...out].sort((a, b) => (b.purchasedAt || "").localeCompare(a.purchasedAt || ""));
  }, [rows, search]);

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
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border bg-card overflow-hidden">
        {isLoading && rows.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-12">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-12">
            {rows.length === 0 ? "No purchased domains yet — buy some from the Buy tab." : "No domains match your search."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] text-muted-foreground border-b">
                  <th className="text-left font-medium px-3 py-2.5">Domain</th>
                  <th className="text-right font-medium px-3 py-2.5 w-[110px]">Price paid</th>
                  <th className="text-right font-medium px-3 py-2.5 w-[130px]">Purchased</th>
                  <th className="text-right font-medium px-3 py-2.5 w-[130px]">Renewal</th>
                  <th className="text-left font-medium px-3 py-2.5 w-[100px]">In use</th>
                  <th className="text-left font-medium px-3 py-2.5 w-[130px]">Provider</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((r) => <Row key={r.domain} r={r} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ r }: { r: PurchasedRow }) {
  return (
    <tr className="hover:bg-muted/30 transition-colors">
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="font-medium">{r.domain}</span>
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
