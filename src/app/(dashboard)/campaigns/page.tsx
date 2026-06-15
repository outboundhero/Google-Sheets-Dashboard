"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  Search, X, Send, Mail, Reply, AlertTriangle, CheckCircle2,
  ChevronDown, ChevronUp, RefreshCw, Loader2, Check,
  Pause, Play, Archive as ArchiveIcon, Circle, MinusCircle, AlertCircle,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip,
} from "recharts";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CampaignDetailDialog } from "@/components/campaigns/campaign-detail-dialog";
import {
  BulkStatusDialog,
  type BulkAction,
  type BulkSelectedRow,
} from "@/components/campaigns/bulk-status-dialog";
import { useInstance } from "@/lib/instance-context";
import { useAuth } from "@/lib/auth-context";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

interface Campaign {
  id: number;
  instance: BisonInstanceSlug;
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

type StepState = "queued" | "running" | "done" | "skipped" | "failed";
interface BulkJobItem {
  key: string;
  instance: BisonInstanceSlug;
  id: number;
  name: string;
  state: StepState;
  note?: { tone: "muted" | "error"; text: string };
}
interface BulkJob {
  action: BulkAction;
  items: BulkJobItem[];
  tally: { done: number; skipped: number; failed: number };
  running: boolean;
}

// What `status` becomes after a successful action (used for optimistic row update).
const NEW_STATUS_FOR: Record<BulkAction, string> = {
  pause: "paused",
  resume: "active",
  archive: "archived",
};

// Walks one PATCH against /api/campaigns/{id}/status. 3 attempts on transient
// (non-JSON / network) errors. 404 → classified as "skipped" because the row
// is stale (campaign deleted in Bison long ago).
async function callBulkStep(
  inst: BisonInstanceSlug,
  id: number,
  action: BulkAction,
): Promise<{ ok: boolean; skipped?: { reason: string }; error?: string }> {
  const attempts = 3;
  let lastErr: string | undefined;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`/api/campaigns/${id}/status?instance=${inst}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const text = await res.text();
      let json: { error?: string } | null = null;
      try { json = JSON.parse(text); } catch {
        lastErr = "non-JSON response (transient)";
        if (i < attempts - 1) { await new Promise((r) => setTimeout(r, 800 * (i + 1))); continue; }
        return { ok: false, error: lastErr };
      }
      if (res.ok) return { ok: true };
      if (res.status === 404) return { ok: false, skipped: { reason: "no longer in Bison (stale row)" } };
      return { ok: false, error: json?.error || `HTTP ${res.status}` };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : "request failed";
      if (i < attempts - 1) { await new Promise((r) => setTimeout(r, 800 * (i + 1))); continue; }
    }
  }
  return { ok: false, error: lastErr || "request failed" };
}

function StatusDot({ state }: { state: StepState }) {
  if (state === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500 shrink-0" />;
  if (state === "done")    return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />;
  if (state === "skipped") return <MinusCircle className="h-3.5 w-3.5 text-zinc-400 dark:text-zinc-500 shrink-0" />;
  if (state === "failed")  return <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />;
  return <Circle className="h-3.5 w-3.5 text-zinc-300 dark:text-zinc-600 shrink-0" />;
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

const keyOf = (c: { instance: BisonInstanceSlug; id: number }) => `${c.instance}:${c.id}`;

// ---------- Client Multi-Select Dropdown (search + drag-select) ----------
// Mirrors the deliverability Tag filter: a searchable popover whose rows can be
// drag-selected (mouse-down on a row, drag down, release) the same way the
// campaign table itself supports drag selection.
function ClientFilterDropdown({
  allClients,
  selected,
  onChange,
}: {
  allClients: string[];
  selected: string[];
  onChange: (clients: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  // Drag-to-select state. We snapshot the selection at drag start and re-apply
  // the whole start→current range on every enter, so a missed event can't leave
  // a gap (selection lives in the parent, so functional updates aren't available).
  const isDragging = useRef(false);
  const dragSelectMode = useRef(true); // true = selecting, false = deselecting
  const dragStartIdx = useRef(-1);
  const dragLastIdx = useRef(-1);
  const dragBase = useRef<Set<string>>(new Set());

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    const onUp = () => { isDragging.current = false; dragStartIdx.current = -1; dragLastIdx.current = -1; };
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, []);

  const filtered = useMemo(
    () => allClients.filter((c) => c.toLowerCase().includes(search.toLowerCase())),
    [allClients, search]
  );

  const applyRange = useCallback((a: number, b: number) => {
    const from = Math.min(a, b);
    const to = Math.max(a, b);
    const next = new Set(dragBase.current);
    for (let i = from; i <= to; i++) {
      const c = filtered[i];
      if (!c) continue;
      if (dragSelectMode.current) next.add(c); else next.delete(c);
    }
    onChange(Array.from(next));
  }, [filtered, onChange]);

  const handleDragStart = (idx: number, client: string) => {
    isDragging.current = true;
    dragStartIdx.current = idx;
    dragLastIdx.current = idx;
    dragSelectMode.current = !selected.includes(client);
    dragBase.current = new Set(selected);
    applyRange(idx, idx);
  };

  const handleDragEnter = (idx: number) => {
    if (!isDragging.current || idx === dragLastIdx.current) return;
    dragLastIdx.current = idx;
    applyRange(dragStartIdx.current, idx);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${
          selected.length > 0
            ? "border-primary bg-primary/10 text-primary"
            : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
        }`}
      >
        <span>{selected.length > 0 ? "Clients" : "All Clients"}</span>
        {selected.length > 0 && (
          <span className="bg-primary text-primary-foreground text-[10px] font-medium rounded-full w-4 h-4 flex items-center justify-center">
            {selected.length}
          </span>
        )}
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1.5 z-50 w-56 rounded-xl border bg-popover shadow-lg overflow-hidden">
          {/* Search */}
          <div className="flex items-center gap-2 px-3 py-2 border-b">
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search clients…"
              className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
            />
            {search && (
              <button onClick={() => setSearch("")}>
                <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
              </button>
            )}
          </div>

          {/* Clear all */}
          {selected.length > 0 && (
            <button
              onClick={() => onChange([])}
              className="w-full text-left px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent border-b"
            >
              Clear all ({selected.length} selected)
            </button>
          )}

          {/* Client list (drag-selectable) */}
          <div className="max-h-64 overflow-y-auto select-none">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground text-center">No clients found</div>
            ) : (
              filtered.map((client, idx) => {
                const isSelected = selected.includes(client);
                return (
                  <div
                    key={client}
                    onMouseDown={(e) => { e.preventDefault(); handleDragStart(idx, client); }}
                    onMouseEnter={() => handleDragEnter(idx)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left transition-colors cursor-pointer"
                  >
                    <div className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                      isSelected ? "bg-primary border-primary" : "border-border"
                    }`}>
                      {isSelected && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                    </div>
                    <span className="truncate">{client}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
// ------------------------------------------------------------------------

export default function CampaignsPage() {
  const { instances, instancesQuery } = useInstance();
  const { role } = useAuth();
  const isAdmin = role === "admin";
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");
  const [clientFilters, setClientFilters] = useState<string[]>([]);
  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null);
  const [lowLeadsOpen, setLowLeadsOpen] = useState(true);
  const [sortField, setSortField] = useState<"created_at" | "remaining_leads" | "emails_sent" | "replied">("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [failedCampaigns, setFailedCampaigns] = useState<{ id: number; name: string; status: string }[]>([]);

  // Bulk selection + drag-to-select (mirrors deliverability/page.tsx).
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const isDragging = useRef(false);
  const dragSelectMode = useRef<boolean>(true);
  const dragLastIdx = useRef(-1);

  // Confirmation dialog state + running job state (progress card).
  const [confirmAction, setConfirmAction] = useState<BulkAction | null>(null);
  const [bulkJob, setBulkJob] = useState<BulkJob | null>(null);

  // Sequence numbers so a late response from a previous instances scope
  // (e.g. the brief Group 1 default on refresh before localStorage hydrates
  // to Group 2) doesn't overwrite the current scope's data.
  const campaignsSeqRef = useRef(0);
  const failedSeqRef = useRef(0);

  const loadCampaigns = useCallback(async () => {
    const seq = ++campaignsSeqRef.current;
    setCampaigns([]);
    try {
      const res = await fetch(`/api/campaigns?${instancesQuery}`, { cache: "no-store" });
      const data = await res.json();
      if (seq !== campaignsSeqRef.current) return;
      if (data.campaigns && Array.isArray(data.campaigns)) {
        setCampaigns(data.campaigns);
      } else if (Array.isArray(data)) {
        setCampaigns(data);
      }
    } catch { /* ignore */ }
  }, [instancesQuery]);

  const loadFailedCampaigns = useCallback(async () => {
    const seq = ++failedSeqRef.current;
    setFailedCampaigns([]);
    try {
      // Failed campaigns route is single-instance; fetch each and merge.
      const results = await Promise.allSettled(
        instances.map(async (inst) => {
          const res = await fetch(`/api/campaigns/failed?instance=${inst.slug}`, { cache: "no-store" });
          const data = await res.json();
          return Array.isArray(data) ? data : [];
        }),
      );
      if (seq !== failedSeqRef.current) return;
      const merged = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
      setFailedCampaigns(merged);
    } catch { /* ignore */ }
  }, [instances]);

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
      // Sync each instance in the active group/tier in parallel
      await Promise.allSettled(
        instances.map((inst) => fetch(`/api/campaigns?instance=${inst.slug}`, { method: "POST" })),
      );
      await loadCampaigns();
    } catch { /* ignore */ }
    setSyncing(false);
  };

  const clientTags = useMemo(() => {
    const tags = new Set<string>();
    for (const c of campaigns) if (c.client_tag) tags.add(c.client_tag);
    return Array.from(tags).sort();
  }, [campaigns]);

  // Bison sometimes returns status with different casing / trailing whitespace;
  // normalise once here so the filter buttons and the filter logic always agree.
  const normStatus = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of campaigns) {
      const key = normStatus(c.status) || "unknown";
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }, [campaigns]);

  const filtered = useMemo(() => {
    let result = campaigns;
    if (statusFilter !== "all") result = result.filter((c) => normStatus(c.status) === statusFilter);
    if (clientFilters.length > 0) result = result.filter((c) => clientFilters.includes(c.client_tag));
    // Search supports a comma-separated list of client tag abbreviations (or any
    // substring): a campaign matches if its name or tag contains ANY of the terms.
    const terms = search.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (terms.length > 0) {
      result = result.filter((c) => {
        const name = c.name.toLowerCase();
        const tag = c.client_tag.toLowerCase();
        return terms.some((q) => name.includes(q) || tag.includes(q));
      });
    }
    return [...result].sort((a, b) => {
      if (sortField === "created_at") {
        const diff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        return sortDir === "desc" ? -diff : diff;
      }
      return sortDir === "desc" ? b[sortField] - a[sortField] : a[sortField] - b[sortField];
    });
  }, [campaigns, statusFilter, clientFilters, search, sortField, sortDir]);

  // Clients with <1500 remaining leads (active only)
  const lowLeadsClients = useMemo(() => {
    const map = new Map<string, { remaining: number; campaigns: Campaign[] }>();
    for (const c of campaigns) {
      if (normStatus(c.status) !== "active" || !c.client_tag) continue;
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
    active: campaigns.filter((c) => normStatus(c.status) === "active").length,
    totalSent: campaigns.reduce((s, c) => s + c.emails_sent, 0),
    totalReplied: campaigns.reduce((s, c) => s + c.replied, 0),
  }), [campaigns]);

  const toggleSort = (field: typeof sortField) => {
    if (sortField === field) setSortDir((d) => d === "desc" ? "asc" : "desc");
    else { setSortField(field); setSortDir("desc"); }
  };

  const SortIndicator = ({ field }: { field: typeof sortField }) =>
    sortField === field ? (sortDir === "desc" ? <ChevronDown className="h-3 w-3 inline ml-0.5" /> : <ChevronUp className="h-3 w-3 inline ml-0.5" />) : null;

  // --- Selection helpers ---------------------------------------------------
  const selectedRows = useMemo<BulkSelectedRow[]>(() => {
    const out: BulkSelectedRow[] = [];
    for (const c of campaigns) {
      if (selectedKeys.has(keyOf(c))) {
        out.push({ instance: c.instance, id: c.id, name: c.name, status: c.status });
      }
    }
    return out;
  }, [campaigns, selectedKeys]);

  // End drag globally on mouse up — handles drag-release outside the table.
  useEffect(() => {
    const onUp = () => { isDragging.current = false; dragLastIdx.current = -1; };
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, []);

  const handleDragStart = useCallback((idx: number, key: string) => {
    isDragging.current = true;
    dragLastIdx.current = idx;
    const wasSelected = selectedKeys.has(key);
    dragSelectMode.current = !wasSelected;
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (dragSelectMode.current) next.add(key);
      else next.delete(key);
      return next;
    });
  }, [selectedKeys]);

  const handleDragEnter = useCallback((idx: number, list: Campaign[]) => {
    if (!isDragging.current || idx === dragLastIdx.current) return;
    const from = Math.min(dragLastIdx.current, idx);
    const to = Math.max(dragLastIdx.current, idx);
    dragLastIdx.current = idx;
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      for (let i = from; i <= to; i++) {
        const k = list[i] ? keyOf(list[i]) : null;
        if (!k) continue;
        if (dragSelectMode.current) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  }, []);

  // --- Bulk action runner (4-parallel worker pool) -------------------------
  const runBulkAction = useCallback(async (action: BulkAction, rows: BulkSelectedRow[]) => {
    if (rows.length === 0) return;
    const items: BulkJobItem[] = rows.map((r) => ({
      key: keyOf(r),
      instance: r.instance,
      id: r.id,
      name: r.name,
      state: "queued",
    }));
    setBulkJob({ action, items, tally: { done: 0, skipped: 0, failed: 0 }, running: true });
    setSelectedKeys(new Set());

    const updateItem = (key: string, patch: Partial<BulkJobItem>) =>
      setBulkJob((prev) => prev ? {
        ...prev,
        items: prev.items.map((it) => it.key === key ? { ...it, ...patch } : it),
      } : prev);

    const bumpTally = (kind: "done" | "skipped" | "failed") =>
      setBulkJob((prev) => prev ? { ...prev, tally: { ...prev.tally, [kind]: prev.tally[kind] + 1 } } : prev);

    const updateRowStatus = (key: string, newStatus: string) =>
      setCampaigns((prev) => prev.map((c) => keyOf(c) === key ? { ...c, status: newStatus } : c));

    // Simple bounded-concurrency worker pool.
    const CONC = 4;
    let next = 0;
    const worker = async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        const it = items[i];
        updateItem(it.key, { state: "running" });
        const result = await callBulkStep(it.instance, it.id, action);
        if (result.ok) {
          updateItem(it.key, { state: "done" });
          updateRowStatus(it.key, NEW_STATUS_FOR[action]);
          bumpTally("done");
        } else if (result.skipped) {
          updateItem(it.key, { state: "skipped", note: { tone: "muted", text: result.skipped.reason } });
          bumpTally("skipped");
        } else {
          updateItem(it.key, { state: "failed", note: { tone: "error", text: result.error || "failed" } });
          bumpTally("failed");
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONC, items.length) }, () => worker()));
    setBulkJob((prev) => prev ? { ...prev, running: false } : prev);
  }, []);

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
            placeholder="Search campaigns or JPPS, SC, ABM…"
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

        <ClientFilterDropdown
          allClients={clientTags}
          selected={clientFilters}
          onChange={setClientFilters}
        />

        {filtered.length !== campaigns.length && (
          <span className="text-xs text-muted-foreground">{filtered.length} result{filtered.length !== 1 ? "s" : ""}</span>
        )}
      </div>

      {/* Bulk action progress card */}
      {bulkJob && (
        <div className="rounded-lg border bg-muted/30 px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-sm">
              {bulkJob.running ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
              )}
              <span className="font-medium capitalize">
                {bulkJob.action} {bulkJob.items.length} campaign{bulkJob.items.length === 1 ? "" : "s"}
              </span>
              <span className="text-xs text-muted-foreground">
                {bulkJob.tally.done} done
                {bulkJob.tally.skipped > 0 ? ` · ${bulkJob.tally.skipped} skipped` : ""}
                {bulkJob.tally.failed > 0 ? ` · ${bulkJob.tally.failed} failed` : ""}
              </span>
            </div>
            {!bulkJob.running && (
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setBulkJob(null)}>
                Dismiss
              </Button>
            )}
          </div>
          <ul className="space-y-1 max-h-44 overflow-y-auto text-xs">
            {bulkJob.items.map((it) => (
              <li
                key={it.key}
                className={`flex items-center gap-2 px-1 py-0.5 ${it.state === "skipped" ? "opacity-60" : ""}`}
              >
                <StatusDot state={it.state} />
                <span className="truncate flex-1">
                  <span className="text-muted-foreground mr-1">[{it.instance}]</span>{it.name}
                </span>
                {it.note && (
                  <span
                    className={`text-[10px] truncate max-w-[200px] italic ${
                      it.note.tone === "error" ? "text-red-500" : "text-muted-foreground"
                    }`}
                    title={it.note.text}
                  >
                    {it.note.text}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Bulk action toolbar (admin-only, appears with selection) */}
      {isAdmin && selectedRows.length > 0 && (
        <div className="flex items-center gap-3 rounded-xl border bg-muted/50 px-4 py-2.5">
          <span className="text-xs font-medium whitespace-nowrap">
            {selectedRows.length.toLocaleString("en-US")} campaign{selectedRows.length === 1 ? "" : "s"} selected
          </span>
          <div className="flex flex-wrap items-center justify-end gap-2 ml-auto">
            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => setConfirmAction("pause")}>
              <Pause className="h-3.5 w-3.5" /> Pause
            </Button>
            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => setConfirmAction("resume")}>
              <Play className="h-3.5 w-3.5" /> Resume
            </Button>
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-red-500 hover:text-red-600" onClick={() => setConfirmAction("archive")}>
              <ArchiveIcon className="h-3.5 w-3.5" /> Archive
            </Button>
            <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setSelectedKeys(new Set())}>
              Clear
            </Button>
          </div>
        </div>
      )}

      {/* Campaign Table */}
      <div className="rounded-xl border overflow-hidden">
        <div
          style={{ gridTemplateColumns: isAdmin
            ? "24px 1fr 70px 90px 90px 80px 70px 80px 70px"
            : "1fr 70px 90px 90px 80px 70px 80px 70px" }}
          className="grid gap-2 px-4 py-2 text-[11px] text-muted-foreground font-medium bg-muted/30 border-b"
        >
          {isAdmin && (
            <button
              onClick={() => {
                const visibleKeys = filtered.map((c) => keyOf(c));
                const allSelected = visibleKeys.length > 0 && visibleKeys.every((k) => selectedKeys.has(k));
                setSelectedKeys(allSelected ? new Set() : new Set(visibleKeys));
              }}
              className={`h-4 w-4 rounded border flex items-center justify-center transition-colors ${
                filtered.length > 0 && filtered.every((c) => selectedKeys.has(keyOf(c)))
                  ? "bg-primary border-primary text-primary-foreground"
                  : "border-muted-foreground/30 hover:border-foreground"
              }`}
              aria-label="Select all visible"
            >
              {filtered.length > 0 && filtered.every((c) => selectedKeys.has(keyOf(c))) && <Check className="h-3 w-3" />}
            </button>
          )}
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
          <div className="divide-y select-none">
            {filtered.map((c, idx) => {
              const replyRate = c.emails_sent > 0 ? ((c.replied / c.emails_sent) * 100).toFixed(1) : "0";
              const key = keyOf(c);
              const isSelected = selectedKeys.has(key);
              return (
                <div
                  key={key}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedCampaign(c)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedCampaign(c); } }}
                  onMouseEnter={() => handleDragEnter(idx, filtered)}
                  style={{ gridTemplateColumns: isAdmin
                    ? "24px 1fr 70px 90px 90px 80px 70px 80px 70px"
                    : "1fr 70px 90px 90px 80px 70px 80px 70px" }}
                  className={`grid gap-2 items-center px-4 py-2.5 w-full text-left cursor-pointer transition-colors ${
                    isSelected ? "bg-primary/5" : "hover:bg-muted/30"
                  }`}
                >
                  {isAdmin && (
                    <button
                      onMouseDown={(e) => { e.preventDefault(); handleDragStart(idx, key); }}
                      onClick={(e) => e.stopPropagation()}
                      className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                        isSelected
                          ? "bg-primary border-primary text-primary-foreground"
                          : "border-muted-foreground/30 hover:border-foreground"
                      }`}
                      aria-label={isSelected ? "Deselect campaign" : "Select campaign"}
                    >
                      {isSelected && <Check className="h-3 w-3" />}
                    </button>
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{c.name}</p>
                    {c.client_tag && <span className="text-[10px] text-muted-foreground">{c.client_tag}</span>}
                  </div>
                  <div className="text-center">
                    <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${STATUS_COLORS[c.status] || ""}`}>{c.status}</Badge>
                  </div>
                  <p className={`text-center text-sm tabular-nums ${c.remaining_leads < 1500 && normStatus(c.status) === "active" ? "text-amber-500 font-medium" : ""}`}>
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
                </div>
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

      {confirmAction && (
        <BulkStatusDialog
          open={!!confirmAction}
          onOpenChange={(o) => { if (!o) setConfirmAction(null); }}
          action={confirmAction}
          rows={selectedRows}
          onConfirm={() => runBulkAction(confirmAction, selectedRows)}
        />
      )}
    </div>
  );
}
