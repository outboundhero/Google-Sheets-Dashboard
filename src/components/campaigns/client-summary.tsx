"use client";

import { Fragment, useMemo, useState } from "react";
import useSWR from "swr";
import { Users, Search, X, ChevronRight, ChevronDown, RefreshCw, Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useInstance } from "@/lib/instance-context";
import { useCampaigns, type CampaignData } from "@/lib/hooks/use-campaigns";
import { INSTANCE_SHORT_LABELS } from "@/lib/bison-instances";

// §13 / §6 — per-client and per-instance campaign summary. Aggregates the master
// grid (one row per campaign) up to client tag, broken down by sending instance.
// Non-nurture metrics: Main campaigns, Main leads, Main completion, remaining
// leads, and failed/blocked duplication actions.

const fetcher = (url: string) => fetch(url).then((r) => r.json());
const isMain = (c: CampaignData) => /^main$/i.test(c.effective_stage || "");

interface Agg { campaigns: number; mainCampaigns: number; mainLeads: number; mainContacted: number; remaining: number }
function emptyAgg(): Agg { return { campaigns: 0, mainCampaigns: 0, mainLeads: 0, mainContacted: 0, remaining: 0 }; }
function add(a: Agg, c: CampaignData) {
  a.campaigns++;
  a.remaining += c.remaining_leads || 0;
  if (isMain(c)) { a.mainCampaigns++; a.mainLeads += c.total_leads || 0; a.mainContacted += c.total_leads_contacted || 0; }
}
const completion = (a: Agg) => (a.mainLeads > 0 ? (a.mainContacted / a.mainLeads) * 100 : 0);

export function ClientSummary() {
  const { instancesQuery } = useInstance();
  const { campaigns, isLoading, mutate } = useCampaigns(instancesQuery);
  const { data: dup } = useSWR<{ jobs: { tags: { clientTag: string; counts: { failed: number; blocked: number } }[] }[] }>("/api/campaigns/duplicate", fetcher, { refreshInterval: 15000 });
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);

  // Failed/blocked duplication actions per client tag.
  const dupIssues = useMemo(() => {
    const m = new Map<string, number>();
    for (const j of dup?.jobs || []) for (const t of j.tags) {
      const n = (t.counts.failed || 0) + (t.counts.blocked || 0);
      if (n > 0) m.set(t.clientTag.toUpperCase(), (m.get(t.clientTag.toUpperCase()) || 0) + n);
    }
    return m;
  }, [dup]);

  const clients = useMemo(() => {
    const m = new Map<string, { tag: string; total: Agg; byInstance: Map<string, Agg> }>();
    for (const c of campaigns) {
      const tag = (c.client_tag || "—").toUpperCase();
      if (!m.has(tag)) m.set(tag, { tag, total: emptyAgg(), byInstance: new Map() });
      const e = m.get(tag)!;
      add(e.total, c);
      if (!e.byInstance.has(c.instance)) e.byInstance.set(c.instance, emptyAgg());
      add(e.byInstance.get(c.instance)!, c);
    }
    let list = Array.from(m.values());
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((e) => e.tag.toLowerCase().includes(q));
    return list.sort((a, b) => a.tag.localeCompare(b.tag));
  }, [campaigns, search]);

  const grand = useMemo(() => {
    const g = emptyAgg();
    for (const c of campaigns) add(g, c);
    return g;
  }, [campaigns]);

  const toggle = (tag: string) => setOpen((s) => { const n = new Set(s); if (n.has(tag)) n.delete(tag); else n.add(tag); return n; });
  const refresh = async () => { setRefreshing(true); try { await mutate(); } finally { setRefreshing(false); } };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="rounded-lg bg-primary/10 p-2"><Users className="h-5 w-5 text-primary" /></div>
        <div className="flex-1">
          <h1 className="text-lg font-semibold tracking-tight">Campaigns — By Client</h1>
          <p className="text-xs text-muted-foreground">Per-client and per-instance rollup · Main leads, completion, remaining, and duplication issues</p>
        </div>
        <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" onClick={refresh} disabled={refreshing}>
          {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Clients" value={clients.length} />
        <Stat label="Main campaigns" value={grand.mainCampaigns} />
        <Stat label="Main leads" value={grand.mainLeads.toLocaleString()} />
        <Stat label="Remaining leads" value={grand.remaining.toLocaleString()} />
      </div>

      <div className="flex items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 w-56">
        <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search client tag…" className="flex-1 text-xs bg-transparent outline-none placeholder:text-muted-foreground" />
        {search && <button onClick={() => setSearch("")}><X className="h-3 w-3 text-muted-foreground hover:text-foreground" /></button>}
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        {isLoading && campaigns.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-12">Loading…</div>
        ) : clients.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-12">No clients match.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] text-muted-foreground border-b">
                  <th className="text-left font-medium px-3 py-2.5">Client tag</th>
                  <th className="text-right font-medium px-3 py-2.5 w-[90px]">Campaigns</th>
                  <th className="text-right font-medium px-3 py-2.5 w-[100px]">Main</th>
                  <th className="text-right font-medium px-3 py-2.5 w-[110px]">Main leads</th>
                  <th className="text-left font-medium px-3 py-2.5 w-[150px]">Main completion</th>
                  <th className="text-right font-medium px-3 py-2.5 w-[110px]">Remaining</th>
                  <th className="text-right font-medium px-3 py-2.5 w-[110px]">Dup issues</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {clients.map((e) => {
                  const multi = e.byInstance.size > 1;
                  const isOpen = open.has(e.tag);
                  const issues = dupIssues.get(e.tag) || 0;
                  return (
                    <Fragment key={e.tag}>
                      <tr className={`transition-colors ${multi ? "cursor-pointer hover:bg-muted/30" : ""}`} onClick={() => multi && toggle(e.tag)}>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-1.5">
                            {multi ? (isOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />) : <span className="w-3.5" />}
                            <span className="font-medium">{e.tag}</span>
                            <span className="flex gap-1">{Array.from(e.byInstance.keys()).map((i) => <span key={i} className="rounded border bg-muted/40 px-1 text-[9px] text-muted-foreground">{INSTANCE_SHORT_LABELS[i as keyof typeof INSTANCE_SHORT_LABELS] || i}</span>)}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{e.total.campaigns}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{e.total.mainCampaigns}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{e.total.mainLeads.toLocaleString()}</td>
                        <td className="px-3 py-2.5"><CompletionBar pct={completion(e.total)} /></td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{e.total.remaining.toLocaleString()}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{issues > 0 ? <span className="inline-flex items-center gap-1 text-destructive"><AlertTriangle className="h-3 w-3" />{issues}</span> : <span className="text-muted-foreground">—</span>}</td>
                      </tr>
                      {multi && isOpen && Array.from(e.byInstance.entries()).map(([inst, a]) => (
                        <tr key={`${e.tag}:${inst}`} className="bg-muted/20 text-[11px]">
                          <td className="px-3 py-1.5 pl-10 text-muted-foreground">{INSTANCE_SHORT_LABELS[inst as keyof typeof INSTANCE_SHORT_LABELS] || inst}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{a.campaigns}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{a.mainCampaigns}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{a.mainLeads.toLocaleString()}</td>
                          <td className="px-3 py-1.5"><CompletionBar pct={completion(a)} /></td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{a.remaining.toLocaleString()}</td>
                          <td className="px-3 py-1.5" />
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function CompletionBar({ pct }: { pct: number }) {
  const p = Math.max(0, Math.min(100, pct));
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden"><div className={`h-full ${p >= 80 ? "bg-emerald-500" : "bg-primary"}`} style={{ width: `${p}%` }} /></div>
      <span className="text-[10px] tabular-nums text-muted-foreground w-9 text-right">{p.toFixed(0)}%</span>
    </div>
  );
}
function Stat({ label, value }: { label: string; value: string | number }) {
  return <div className="rounded-xl border bg-card px-3 py-2"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p><p className="text-lg font-semibold tabular-nums">{value}</p></div>;
}
