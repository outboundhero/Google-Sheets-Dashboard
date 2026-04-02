"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  Search, X, Send, Mail, Reply, AlertTriangle, CheckCircle2,
  ChevronDown, ChevronUp, RefreshCw, Loader2,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip,
} from "recharts";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CampaignDetailDialog } from "@/components/campaigns/campaign-detail-dialog";

interface Campaign {
  id: number;
  name: string;
  status: string;
  client_tag: string;
  total_leads: number;
  total_leads_contacted: number;
  remaining_leads: number;
  emails_sent: number;
  replied: number;
  unique_replies: number;
  bounced: number;
  opened: number;
  unique_opens: number;
  interested: number;
  unsubscribed: number;
  completion_percentage: number;
  created_at: string;
  updated_at: string;
}

const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
  paused: "bg-amber-500/10 text-amber-500 border-amber-500/20",
  completed: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  draft: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
  archived: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
  failed: "bg-red-500/10 text-red-400 border-red-500/20",
};

const ChartTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ value: number; payload: { client: string } }> }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-popover px-3 py-1.5 text-xs shadow-md text-popover-foreground">
      <span className="font-medium">{payload[0].payload.client}</span>
      <span className="text-muted-foreground ml-2">{payload[0].value.toLocaleString()} remaining</span>
    </div>
  );
};

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");
  const [clientFilter, setClientFilter] = useState("all");
  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null);
  const [lowLeadsOpen, setLowLeadsOpen] = useState(true);
  const [sortField, setSortField] = useState<"created_at" | "remaining_leads" | "emails_sent" | "replied">("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [failedCampaigns, setFailedCampaigns] = useState<{ id: number; name: string; status: string }[]>([]);

  const loadCampaigns = useCallback(async () => {
    try {
      const res = await fetch("/api/campaigns");
      const data = await res.json();
      if (data.campaigns && Array.isArray(data.campaigns)) {
        setCampaigns(data.campaigns);
      } else if (Array.isArray(data)) {
        setCampaigns(data);
      }
    } catch { /* ignore */ }
  }, []);

  const loadFailedCampaigns = useCallback(async () => {
    try {
      const res = await fetch("/api/campaigns/failed");
      const data = await res.json();
      if (Array.isArray(data)) setFailedCampaigns(data);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    setLoading(true);
    // Load main campaigns first, then failed (sequentially to avoid rate limits)
    loadCampaigns()
      .then(() => loadFailedCampaigns())
      .finally(() => setLoading(false));
  }, [loadCampaigns, loadFailedCampaigns]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await fetch("/api/campaigns", { method: "POST" });
      await loadCampaigns();
    } catch { /* ignore */ }
    setSyncing(false);
  };

  const clientTags = useMemo(() => {
    const tags = new Set<string>();
    for (const c of campaigns) if (c.client_tag) tags.add(c.client_tag);
    return Array.from(tags).sort();
  }, [campaigns]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of campaigns) counts[c.status] = (counts[c.status] || 0) + 1;
    return counts;
  }, [campaigns]);

  const filtered = useMemo(() => {
    let result = campaigns;
    if (statusFilter !== "all") result = result.filter((c) => c.status === statusFilter);
    if (clientFilter !== "all") result = result.filter((c) => c.client_tag === clientFilter);
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((c) => c.name.toLowerCase().includes(q) || c.client_tag.toLowerCase().includes(q));
    }
    return [...result].sort((a, b) => {
      if (sortField === "created_at") {
        const diff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        return sortDir === "desc" ? -diff : diff;
      }
      return sortDir === "desc" ? b[sortField] - a[sortField] : a[sortField] - b[sortField];
    });
  }, [campaigns, statusFilter, clientFilter, search, sortField, sortDir]);

  // Clients with <1500 remaining leads (active only)
  const lowLeadsClients = useMemo(() => {
    const map = new Map<string, { remaining: number; campaigns: Campaign[] }>();
    for (const c of campaigns) {
      if (c.status !== "active" || !c.client_tag) continue;
      if (!map.has(c.client_tag)) map.set(c.client_tag, { remaining: 0, campaigns: [] });
      const entry = map.get(c.client_tag)!;
      entry.remaining += c.remaining_leads;
      entry.campaigns.push(c);
    }
    return Array.from(map.entries())
      .map(([client, d]) => ({ client, ...d }))
      .filter((d) => d.remaining < 1500 && d.remaining >= 0)
      .sort((a, b) => a.remaining - b.remaining);
  }, [campaigns]);

  const stats = useMemo(() => ({
    total: campaigns.length,
    active: campaigns.filter((c) => c.status === "active").length,
    totalSent: campaigns.reduce((s, c) => s + c.emails_sent, 0),
    totalReplied: campaigns.reduce((s, c) => s + c.replied, 0),
  }), [campaigns]);

  const toggleSort = (field: typeof sortField) => {
    if (sortField === field) setSortDir((d) => d === "desc" ? "asc" : "desc");
    else { setSortField(field); setSortDir("desc"); }
  };

  const SortIndicator = ({ field }: { field: typeof sortField }) =>
    sortField === field ? (sortDir === "desc" ? <ChevronDown className="h-3 w-3 inline ml-0.5" /> : <ChevronUp className="h-3 w-3 inline ml-0.5" />) : null;

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-20" />)}
        </div>
        <Skeleton className="h-64" />
        <div className="space-y-2">{[...Array(8)].map((_, i) => <Skeleton key={i} className="h-14 rounded-xl" />)}</div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Campaigns" description={`${stats.total} campaigns · ${stats.active} active`}>
        <Button variant="outline" size="sm" onClick={handleSync} disabled={syncing} className="gap-2">
          <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
          {syncing ? "Syncing..." : "Sync"}
        </Button>
      </PageHeader>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { icon: Send, label: "Campaigns", value: stats.total, color: "" },
          { icon: Send, label: "Active", value: stats.active, color: "text-emerald-500" },
          { icon: Mail, label: "Emails Sent", value: stats.totalSent.toLocaleString(), color: "" },
          { icon: Reply, label: "Replies", value: stats.totalReplied.toLocaleString(), color: "" },
        ].map((s) => (
          <Card key={s.label}>
            <CardContent className="flex items-center gap-3 p-4">
              <div className="rounded-lg bg-muted p-2">
                <s.icon className="h-4 w-4 text-muted-foreground" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{s.label}</p>
                <p className={`text-xl font-semibold tracking-tight ${s.color}`}>{s.value}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Failed Campaigns Alert */}
      <div className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${
        failedCampaigns.length > 0
          ? "border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-950/20"
          : "border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-950/20"
      }`}>
        <AlertTriangle className={`h-4 w-4 shrink-0 mt-0.5 ${
          failedCampaigns.length > 0 ? "text-red-500 dark:text-red-400" : "text-emerald-500 dark:text-emerald-400"
        }`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-semibold ${
              failedCampaigns.length > 0 ? "text-red-700 dark:text-red-200" : "text-emerald-700 dark:text-emerald-200"
            }`}>Failed Campaigns</span>
            <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${
              failedCampaigns.length > 0
                ? "bg-red-100 dark:bg-red-500/10 text-red-600 dark:text-red-400 border-red-200 dark:border-red-500/20"
                : "bg-emerald-100 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20"
            }`}>
              {failedCampaigns.length}
            </Badge>
          </div>
          {failedCampaigns.length > 0 ? (
            <div className="mt-1.5 space-y-1">
              {failedCampaigns.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelectedCampaign(campaigns.find((x) => x.id === c.id) || null)}
                  className="flex items-center gap-2 w-full text-xs text-red-600 dark:text-red-300 hover:text-red-800 dark:hover:text-red-100 py-0.5 transition-colors text-left"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-red-400 dark:bg-red-500 shrink-0" />
                  <span className="truncate">{c.name}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-0.5">No failed campaigns</p>
          )}
        </div>
      </div>

      {/* Low Leads Section */}
      <Card>
        <button onClick={() => setLowLeadsOpen((v) => !v)} className="flex items-center justify-between w-full px-5 py-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            {lowLeadsClients.length > 0 ? (
              <AlertTriangle className="h-4 w-4 text-amber-500" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            )}
            Low Remaining Leads
            <Badge variant="secondary" className="text-[10px]">{lowLeadsClients.length}</Badge>
          </div>
          {lowLeadsOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </button>
        {lowLeadsOpen && (
          <CardContent className="pt-0 space-y-4">
            {lowLeadsClients.length > 0 ? (
              <>
                <div className="rounded-lg bg-muted/30 p-4">
                  <ResponsiveContainer width="100%" height={Math.max(180, lowLeadsClients.length * 32)}>
                    <BarChart data={lowLeadsClients} layout="vertical" margin={{ left: 0, right: 16 }}>
                      <XAxis type="number" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                      <YAxis type="category" dataKey="client" width={70} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                      <Tooltip content={<ChartTooltip />} cursor={{ fill: "transparent" }} />
                      <Bar dataKey="remaining" fill="#f59e0b" radius={[0, 4, 4, 0]} maxBarSize={18} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                <div className="divide-y rounded-lg border">
                  {lowLeadsClients.map((client) => (
                    <div key={client.client} className="px-4 py-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">{client.client}</span>
                        <span className="text-xs font-medium text-amber-500">{client.remaining.toLocaleString()} remaining</span>
                      </div>
                      <div className="mt-1.5 space-y-1 ml-2 border-l border-muted pl-3">
                        {client.campaigns.map((c) => (
                          <button
                            key={c.id}
                            onClick={() => setSelectedCampaign(c)}
                            className="flex items-center gap-2 w-full text-xs text-muted-foreground hover:text-foreground px-2 py-1.5 rounded-md hover:bg-muted/50 transition-colors"
                          >
                            <span className="truncate flex-1 text-left">{c.name.split(":").slice(1).join(":").trim() || c.name}</span>
                            <Badge variant="outline" className={`text-[9px] px-1.5 py-0 shrink-0 ${STATUS_COLORS[c.status] || ""}`}>{c.status}</Badge>
                            <span className="shrink-0 tabular-nums text-muted-foreground">{c.remaining_leads.toLocaleString()} left</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-sm text-emerald-600 dark:text-emerald-400 pb-2">All clients have sufficient remaining leads (above 1,500)</p>
            )}
          </CardContent>
        )}
      </Card>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-1.5 flex-1 min-w-[200px] max-w-xs">
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search campaigns..."
            className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
          />
          {search && <button onClick={() => setSearch("")}><X className="h-3 w-3 text-muted-foreground hover:text-foreground" /></button>}
        </div>

        {["all", "active", "paused", "completed", "archived", "draft", "failed"].map((s) => {
          const count = s === "all" ? campaigns.length : statusCounts[s] || 0;
          if (s !== "all" && !count) return null;
          return (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`text-xs px-2.5 py-1.5 rounded-full border capitalize transition-colors ${
                statusFilter === s
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
              }`}
            >
              {s === "all" ? "All" : s}
              <span className="ml-1 opacity-60">{count}</span>
            </button>
          );
        })}

        <select
          value={clientFilter}
          onChange={(e) => setClientFilter(e.target.value)}
          className="text-xs px-2.5 py-1.5 rounded-lg border bg-background"
        >
          <option value="all">All Clients</option>
          {clientTags.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>

        {filtered.length !== campaigns.length && (
          <span className="text-xs text-muted-foreground">{filtered.length} result{filtered.length !== 1 ? "s" : ""}</span>
        )}
      </div>

      {/* Campaign Table */}
      <div className="rounded-xl border overflow-hidden">
        <div className="grid grid-cols-[1fr_70px_90px_90px_80px_70px_80px_70px] gap-2 px-4 py-2 text-[11px] text-muted-foreground font-medium bg-muted/30 border-b">
          <span>Campaign</span>
          <span className="text-center">Status</span>
          <button onClick={() => toggleSort("remaining_leads")} className="text-center hover:text-foreground transition-colors">Remaining<SortIndicator field="remaining_leads" /></button>
          <button onClick={() => toggleSort("emails_sent")} className="text-center hover:text-foreground transition-colors">Sent<SortIndicator field="emails_sent" /></button>
          <button onClick={() => toggleSort("replied")} className="text-center hover:text-foreground transition-colors">Replied<SortIndicator field="replied" /></button>
          <span className="text-center">Bounced</span>
          <span className="text-center">Leads</span>
          <button onClick={() => toggleSort("created_at")} className="text-center hover:text-foreground transition-colors">Date<SortIndicator field="created_at" /></button>
        </div>

        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16">
            <Send className="h-8 w-8 text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">No campaigns match your filters</p>
          </div>
        ) : (
          <div className="divide-y">
            {filtered.map((c) => {
              const replyRate = c.emails_sent > 0 ? ((c.replied / c.emails_sent) * 100).toFixed(1) : "0";
              return (
                <button
                  key={c.id}
                  onClick={() => setSelectedCampaign(c)}
                  className="grid grid-cols-[1fr_70px_90px_90px_80px_70px_80px_70px] gap-2 items-center px-4 py-2.5 w-full text-left hover:bg-muted/30 transition-colors"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{c.name}</p>
                    {c.client_tag && <span className="text-[10px] text-muted-foreground">{c.client_tag}</span>}
                  </div>
                  <div className="text-center">
                    <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${STATUS_COLORS[c.status] || ""}`}>{c.status}</Badge>
                  </div>
                  <p className={`text-center text-sm tabular-nums ${c.remaining_leads < 1500 && c.status === "active" ? "text-amber-500 font-medium" : ""}`}>
                    {c.remaining_leads.toLocaleString()}
                  </p>
                  <p className="text-center text-sm tabular-nums">{c.emails_sent.toLocaleString()}</p>
                  <div className="text-center">
                    <p className="text-sm tabular-nums">{c.replied.toLocaleString()}</p>
                    <p className="text-[9px] text-muted-foreground">{replyRate}%</p>
                  </div>
                  <p className={`text-center text-sm tabular-nums ${c.bounced > 0 ? "text-red-400" : "text-muted-foreground"}`}>
                    {c.bounced.toLocaleString()}
                  </p>
                  <p className="text-center text-sm tabular-nums">{c.total_leads.toLocaleString()}</p>
                  <p className="text-center text-[11px] text-muted-foreground">
                    {new Date(c.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </p>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {selectedCampaign && (
        <CampaignDetailDialog
          campaign={selectedCampaign}
          open={!!selectedCampaign}
          onOpenChange={(open) => { if (!open) setSelectedCampaign(null); }}
          onStatusChange={(id, newStatus) => {
            setCampaigns((prev) => prev.map((c) => c.id === id ? { ...c, status: newStatus } : c));
            setSelectedCampaign((prev) => prev ? { ...prev, status: newStatus } : prev);
          }}
        />
      )}
    </div>
  );
}
