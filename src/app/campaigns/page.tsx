"use client";

import { useState, useEffect, useMemo } from "react";
import {
  Search,
  X,
  Send,
  Users,
  Mail,
  Reply,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Loader2,
  ExternalLink,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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

const STATUS_BADGE: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  paused: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  completed: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  draft: "bg-gray-500/15 text-gray-400 border-gray-500/30",
  archived: "bg-gray-500/15 text-gray-400 border-gray-500/30",
  failed: "bg-destructive/15 text-destructive border-destructive/30",
};

const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ value: number; payload: { client: string; remaining: number } }> }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-sm shadow-md text-popover-foreground">
      <p className="font-medium">{payload[0].payload.client}</p>
      <p className="text-muted-foreground">{payload[0].value.toLocaleString()} remaining leads</p>
    </div>
  );
};

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [clientFilter, setClientFilter] = useState<string>("all");
  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null);
  const [lowLeadsExpanded, setLowLeadsExpanded] = useState(true);
  const [sortField, setSortField] = useState<"created_at" | "remaining_leads" | "emails_sent" | "replied">("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    setLoading(true);
    fetch("/api/campaigns")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setCampaigns(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Unique client tags
  const clientTags = useMemo(() => {
    const tags = new Set<string>();
    for (const c of campaigns) {
      if (c.client_tag) tags.add(c.client_tag);
    }
    return Array.from(tags).sort();
  }, [campaigns]);

  // Unique statuses
  const statuses = useMemo(() => {
    const s = new Set<string>();
    for (const c of campaigns) s.add(c.status);
    return Array.from(s).sort();
  }, [campaigns]);

  // Filtered campaigns
  const filtered = useMemo(() => {
    let result = campaigns;
    if (statusFilter !== "all") {
      result = result.filter((c) => c.status === statusFilter);
    }
    if (clientFilter !== "all") {
      result = result.filter((c) => c.client_tag === clientFilter);
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((c) => c.name.toLowerCase().includes(q) || c.client_tag.toLowerCase().includes(q));
    }
    // Sort
    result = [...result].sort((a, b) => {
      const aVal = a[sortField] ?? "";
      const bVal = b[sortField] ?? "";
      if (sortField === "created_at") {
        const diff = new Date(aVal as string).getTime() - new Date(bVal as string).getTime();
        return sortDir === "desc" ? -diff : diff;
      }
      const diff = (aVal as number) - (bVal as number);
      return sortDir === "desc" ? -diff : diff;
    });
    return result;
  }, [campaigns, statusFilter, clientFilter, search, sortField, sortDir]);

  // Clients with low remaining leads (< 1500) — only from active campaigns
  const lowLeadsClients = useMemo(() => {
    const clientMap = new Map<string, { remaining: number; campaigns: Campaign[] }>();
    for (const c of campaigns) {
      if (c.status !== "active" || !c.client_tag) continue;
      if (!clientMap.has(c.client_tag)) {
        clientMap.set(c.client_tag, { remaining: 0, campaigns: [] });
      }
      const entry = clientMap.get(c.client_tag)!;
      entry.remaining += c.remaining_leads;
      entry.campaigns.push(c);
    }
    return Array.from(clientMap.entries())
      .map(([client, data]) => ({ client, ...data }))
      .filter((d) => d.remaining < 1500)
      .sort((a, b) => a.remaining - b.remaining);
  }, [campaigns]);

  // Stats
  const stats = useMemo(() => {
    const active = campaigns.filter((c) => c.status === "active").length;
    const totalSent = campaigns.reduce((s, c) => s + c.emails_sent, 0);
    const totalReplied = campaigns.reduce((s, c) => s + c.replied, 0);
    return { total: campaigns.length, active, totalSent, totalReplied };
  }, [campaigns]);

  const handleSort = (field: typeof sortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  };

  const SortIcon = ({ field }: { field: typeof sortField }) => {
    if (sortField !== field) return null;
    return sortDir === "desc" ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />;
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-24" />)}
        </div>
        <Skeleton className="h-80" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Campaigns"
        description={`${stats.total} campaigns · ${stats.active} active`}
      />

      {/* Stats Cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Send className="h-3.5 w-3.5" />
              <span className="text-xs">Total Campaigns</span>
            </div>
            <p className="text-2xl font-bold">{stats.total}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Users className="h-3.5 w-3.5" />
              <span className="text-xs">Active</span>
            </div>
            <p className="text-2xl font-bold text-emerald-500">{stats.active}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Mail className="h-3.5 w-3.5" />
              <span className="text-xs">Emails Sent</span>
            </div>
            <p className="text-2xl font-bold">{stats.totalSent.toLocaleString()}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Reply className="h-3.5 w-3.5" />
              <span className="text-xs">Total Replies</span>
            </div>
            <p className="text-2xl font-bold">{stats.totalReplied.toLocaleString()}</p>
          </CardContent>
        </Card>
      </div>

      {/* Low Leads Alert Section */}
      {lowLeadsClients.length > 0 && (
        <Card className="border-amber-500/30">
          <CardHeader className="pb-2">
            <button
              onClick={() => setLowLeadsExpanded((v) => !v)}
              className="flex items-center justify-between w-full"
            >
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                Clients with Low Remaining Leads (&lt; 1,500)
                <Badge variant="outline" className="ml-1 text-amber-500 border-amber-500/30">
                  {lowLeadsClients.length}
                </Badge>
              </CardTitle>
              {lowLeadsExpanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
            </button>
          </CardHeader>
          {lowLeadsExpanded && (
            <CardContent className="space-y-4">
              {/* Bar Chart */}
              <ResponsiveContainer width="100%" height={Math.max(200, lowLeadsClients.length * 36)}>
                <BarChart data={lowLeadsClients} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <XAxis
                    type="number"
                    tick={{ fontSize: 11, fill: "currentColor" }}
                    className="text-muted-foreground"
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="client"
                    width={100}
                    tick={{ fontSize: 11, fill: "currentColor" }}
                    className="text-foreground"
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip content={<CustomTooltip />} cursor={{ fill: "transparent" }} />
                  <Bar
                    dataKey="remaining"
                    fill="#f59e0b"
                    radius={[0, 6, 6, 0]}
                    maxBarSize={22}
                  />
                </BarChart>
              </ResponsiveContainer>

              {/* Campaign List under each client */}
              <div className="space-y-3 pt-2 border-t">
                {lowLeadsClients.map((client) => (
                  <div key={client.client}>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-sm font-medium">{client.client}</span>
                      <span className="text-xs text-amber-500 font-medium">{client.remaining.toLocaleString()} remaining</span>
                    </div>
                    <div className="space-y-1 ml-3">
                      {client.campaigns.map((c) => (
                        <button
                          key={c.id}
                          onClick={() => setSelectedCampaign(c)}
                          className="flex items-center justify-between w-full text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-muted/50"
                        >
                          <span className="truncate">{c.name}</span>
                          <span className="shrink-0 ml-2">{c.remaining_leads.toLocaleString()} left</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          )}
        </Card>
      )}

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
          {search && (
            <button onClick={() => setSearch("")}>
              <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
            </button>
          )}
        </div>

        {/* Status filter */}
        {["all", ...statuses].map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`text-xs px-3 py-1.5 rounded-full border capitalize transition-colors ${
              statusFilter === s
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
            }`}
          >
            {s === "all" ? "All Status" : s}
            {s !== "all" && (
              <span className="ml-1 opacity-70">
                {campaigns.filter((c) => c.status === s).length}
              </span>
            )}
          </button>
        ))}

        {/* Client tag filter */}
        <select
          value={clientFilter}
          onChange={(e) => setClientFilter(e.target.value)}
          className="text-xs px-3 py-1.5 rounded-full border bg-background text-foreground"
        >
          <option value="all">All Clients</option>
          {clientTags.map((tag) => (
            <option key={tag} value={tag}>{tag}</option>
          ))}
        </select>

        {(search || statusFilter !== "all" || clientFilter !== "all") && (
          <span className="text-xs text-muted-foreground">
            {filtered.length} campaign{filtered.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Campaign List */}
      <div className="space-y-1.5">
        {/* Header */}
        <div className="grid grid-cols-[1fr_80px_100px_80px_80px_80px_80px_100px] gap-3 px-4 py-2 text-xs text-muted-foreground font-medium">
          <span>Campaign</span>
          <span className="text-center">Status</span>
          <button onClick={() => handleSort("remaining_leads")} className="flex items-center justify-center gap-1 hover:text-foreground">
            Remaining <SortIcon field="remaining_leads" />
          </button>
          <button onClick={() => handleSort("emails_sent")} className="flex items-center justify-center gap-1 hover:text-foreground">
            Sent <SortIcon field="emails_sent" />
          </button>
          <button onClick={() => handleSort("replied")} className="flex items-center justify-center gap-1 hover:text-foreground">
            Replied <SortIcon field="replied" />
          </button>
          <span className="text-center">Bounced</span>
          <span className="text-center">Leads</span>
          <button onClick={() => handleSort("created_at")} className="flex items-center justify-center gap-1 hover:text-foreground">
            Created <SortIcon field="created_at" />
          </button>
        </div>

        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Send className="h-10 w-10 text-muted-foreground mb-3" />
            <h3 className="font-medium">No campaigns match your filters</h3>
          </div>
        ) : (
          filtered.map((c) => {
            const replyRate = c.emails_sent > 0 ? ((c.replied / c.emails_sent) * 100).toFixed(1) : "0.0";
            return (
              <button
                key={c.id}
                onClick={() => setSelectedCampaign(c)}
                className="grid grid-cols-[1fr_80px_100px_80px_80px_80px_80px_100px] gap-3 items-center rounded-xl border bg-card px-4 py-3 transition-colors hover:bg-muted/30 w-full text-left"
              >
                <div className="min-w-0">
                  <div className="font-medium text-sm truncate">{c.name}</div>
                  {c.client_tag && (
                    <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground mt-0.5 inline-block">
                      {c.client_tag}
                    </span>
                  )}
                </div>
                <div className="text-center">
                  <Badge className={`text-[10px] ${STATUS_BADGE[c.status] || STATUS_BADGE.draft}`}>
                    {c.status}
                  </Badge>
                </div>
                <div className={`text-center text-sm font-medium ${c.remaining_leads < 1500 && c.status === "active" ? "text-amber-500" : ""}`}>
                  {c.remaining_leads.toLocaleString()}
                </div>
                <div className="text-center text-sm">{c.emails_sent.toLocaleString()}</div>
                <div className="text-center">
                  <div className="text-sm">{c.replied.toLocaleString()}</div>
                  <div className="text-[10px] text-muted-foreground">{replyRate}%</div>
                </div>
                <div className={`text-center text-sm ${c.bounced > 0 ? "text-destructive" : ""}`}>
                  {c.bounced.toLocaleString()}
                </div>
                <div className="text-center text-sm">{c.total_leads.toLocaleString()}</div>
                <div className="text-center text-xs text-muted-foreground">
                  {new Date(c.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </div>
              </button>
            );
          })
        )}
      </div>

      {/* Campaign Detail Dialog */}
      {selectedCampaign && (
        <CampaignDetailDialog
          campaign={selectedCampaign}
          open={!!selectedCampaign}
          onOpenChange={(open) => { if (!open) setSelectedCampaign(null); }}
        />
      )}
    </div>
  );
}
