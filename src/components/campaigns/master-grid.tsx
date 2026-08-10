"use client";

import { useMemo, useState, useRef, useEffect, useCallback } from "react";
import useSWR from "swr";
import { Send, Search, X, RefreshCw, Loader2, Check, ChevronDown, Play, Pause, Archive, Copy, ArrowUpDown, CalendarClock, PanelRight, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { useInstance } from "@/lib/instance-context";
import { useCampaigns, type CampaignData } from "@/lib/hooks/use-campaigns";
import { INSTANCE_SHORT_LABELS } from "@/lib/bison-instances";
import { stageOrder } from "@/lib/campaigns/stage";
import { DuplicateDialog } from "./duplicate-dialog";
import { DuplicationQueuePanel } from "./duplication-queue-panel";
import { BulkScheduleDialog } from "./bulk-schedule-dialog";
import { CampaignDetailDrawer } from "./campaign-detail-drawer";

const keyOf = (c: CampaignData) => `${c.instance}:${c.id}`;
const replyRate = (c: CampaignData) => (c.total_leads_contacted > 0 ? (c.unique_replies / c.total_leads_contacted) * 100 : 0);

type SortKey = "campaign" | "stage" | "class" | "group" | "instance" | "status" | "remaining" | "leads" | "completion" | "senders" | "schedule" | "reply" | "start" | "golive" | "created";
function compareBy(a: CampaignData, b: CampaignData, key: SortKey): number {
  switch (key) {
    case "campaign": return a.name.localeCompare(b.name);
    case "stage": return stageOrder(a.effective_stage || "") - stageOrder(b.effective_stage || "");
    case "class": return (a.classification || "").localeCompare(b.classification || "");
    case "group": return (a.group || 0) - (b.group || 0);
    case "instance": return a.instance.localeCompare(b.instance);
    case "status": return a.status.localeCompare(b.status);
    case "remaining": return (a.remaining_leads || 0) - (b.remaining_leads || 0);
    case "leads": return (a.total_leads || 0) - (b.total_leads || 0);
    case "completion": return (a.completion_percentage || 0) - (b.completion_percentage || 0);
    case "senders": return (a.sender_count || 0) - (b.sender_count || 0);
    case "schedule": return (a.sched_start_time || "").localeCompare(b.sched_start_time || "");
    case "reply": return replyRate(a) - replyRate(b);
    case "start": return (a.client_start_date || "").localeCompare(b.client_start_date || "");
    case "golive": return (a.go_live_date || "").localeCompare(b.go_live_date || "");
    case "created": return (a.created_at || "").localeCompare(b.created_at || "");
  }
}

const STATUS_BADGE: Record<string, string> = {
  active: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
  paused: "bg-amber-500/10 text-amber-600 border-amber-500/20",
  draft: "bg-zinc-500/10 text-zinc-500 border-zinc-500/20",
  completed: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  archived: "bg-muted text-muted-foreground border-border",
  failed: "bg-red-500/10 text-red-600 border-red-500/20",
  launching: "bg-sky-500/10 text-sky-600 border-sky-500/20",
  "launch processing": "bg-sky-500/10 text-sky-600 border-sky-500/20",
};

function stageBadge(stage: string): string {
  if (/^main$/i.test(stage)) return "bg-primary/10 text-primary border-primary/20";
  return "bg-violet-500/10 text-violet-600 border-violet-500/20";
}

// "09:00:00" → "9:00a"; drop seconds, 12h.
function hhmm(t?: string | null): string {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  if (Number.isNaN(h)) return t;
  const ap = h < 12 ? "a" : "p";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m || 0).padStart(2, "0")}${ap}`;
}
function tzAbbr(tz?: string | null): string {
  if (!tz) return "";
  const city = tz.split("/").pop() || tz;
  return city.replace(/_/g, " ");
}

function startBucket(dateStr: string | null | undefined): "1-14" | "15-eom" | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return d.getDate() <= 14 ? "1-14" : "15-eom";
}
// PST "today" bucket (fixed -8, matches the rest of the app).
function currentBucket(): "1-14" | "15-eom" {
  const now = new Date(Date.now() - 8 * 3600_000);
  return now.getUTCDate() <= 14 ? "1-14" : "15-eom";
}

export function MasterGrid() {
  const { role } = useAuth();
  const isAdmin = role === "admin";
  const { instancesQuery } = useInstance();
  const { campaigns, activeClients, isLoading, mutate } = useCampaigns(instancesQuery);
  const { data: dupStatus } = useSWR<{ totals: { queued: number; duplicating: number; failed: number; blocked: number }; jobs: { tags: { clientTag: string; counts: { failed: number; blocked: number } }[] }[] }>("/api/campaigns/duplicate", (u: string) => fetch(u).then((r) => r.json()), { refreshInterval: 15000 });
  const dupQueued = (dupStatus?.totals?.queued ?? 0) + (dupStatus?.totals?.duplicating ?? 0);
  const dupFailed = (dupStatus?.totals?.failed ?? 0) + (dupStatus?.totals?.blocked ?? 0);
  // Client tags with a failed/blocked duplication → per-row warning (§3 warning status).
  const dupIssueTags = useMemo(() => {
    const s = new Set<string>();
    for (const j of dupStatus?.jobs || []) for (const t of j.tags) if ((t.counts.failed || 0) + (t.counts.blocked || 0) > 0) s.add(t.clientTag.toUpperCase());
    return s;
  }, [dupStatus]);
  const hasWarning = (c: CampaignData) => c.status === "failed" || dupIssueTags.has((c.client_tag || "").toUpperCase());

  const [search, setSearch] = useState("");
  const [stages, setStages] = useState<Set<string>>(new Set(["Main"])); // default: Main only
  const [status, setStatus] = useState("all");
  const [classification, setClassification] = useState("all");
  const [group, setGroup] = useState("all");
  const [instanceFilter, setInstanceFilter] = useState("all");
  const [tzFilter, setTzFilter] = useState("all");
  const [complFilter, setComplFilter] = useState("all");
  const [warnOnly, setWarnOnly] = useState(false);
  const [bucket, setBucket] = useState("all");
  const [stageOpen, setStageOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [schedOpen, setSchedOpen] = useState(false);
  const [detail, setDetail] = useState<CampaignData | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("created");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const nowBucket = currentBucket();
  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir(k === "campaign" || k === "stage" || k === "class" || k === "instance" || k === "status" ? "asc" : "desc"); }
  };

  // Distinct filter option sources.
  const allStages = useMemo(() => Array.from(new Set(campaigns.map((c) => c.effective_stage || "Main"))).sort((a, b) => stageOrder(a) - stageOrder(b)), [campaigns]);
  const allStatuses = useMemo(() => Array.from(new Set(campaigns.map((c) => c.status))).filter(Boolean).sort(), [campaigns]);
  const allClasses = useMemo(() => Array.from(new Set(campaigns.map((c) => c.classification || "").filter(Boolean))).sort(), [campaigns]);
  const allInstances = useMemo(() => Array.from(new Set(campaigns.map((c) => c.instance))).sort(), [campaigns]);
  const allTimezones = useMemo(() => Array.from(new Set(campaigns.map((c) => c.sched_timezone).filter(Boolean) as string[])).sort(), [campaigns]);
  const lastUpdated = useMemo(() => campaigns.reduce((m, c) => (c.updated_at && c.updated_at > m ? c.updated_at : m), ""), [campaigns]);
  // §12 "Campaign Missing": rows whose sync went stale vs the newest sync (i.e.
  // no longer returned by Bison, so the sync stopped touching them).
  const lastSync = useMemo(() => campaigns.reduce((m, c) => (c.synced_at && c.synced_at > m ? c.synced_at : m), ""), [campaigns]);
  const isMissing = useCallback((c: CampaignData) => !!(c.synced_at && lastSync && new Date(lastSync).getTime() - new Date(c.synced_at).getTime() > 2 * 86_400_000), [lastSync]);
  // §28 connection-errors card: open campaign sync/connection alerts.
  const { data: alerts } = useSWR<{ alerts?: { source: string; status: string }[] } | { source: string; status: string }[]>("/api/pipeline-alerts", (u: string) => fetch(u).then((r) => r.json()));
  const connErrors = useMemo(() => {
    const arr = Array.isArray(alerts) ? alerts : (alerts?.alerts || []);
    return arr.filter((a) => (a.source || "").startsWith("campaigns")).length;
  }, [alerts]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = campaigns.filter((c) => {
      if (q && !(`${c.name} ${c.client_tag}`.toLowerCase().includes(q))) return false;
      if (stages.size > 0 && !stages.has(c.effective_stage || "Main")) return false;
      if (status !== "all" && c.status !== status) return false;
      if (classification !== "all" && (c.classification || "") !== classification) return false;
      if (group !== "all" && String(c.group ?? "") !== group) return false;
      if (instanceFilter !== "all" && c.instance !== instanceFilter) return false;
      if (tzFilter !== "all" && c.sched_timezone !== tzFilter) return false;
      const pct = c.completion_percentage || 0;
      if (complFilter === "lt50" && pct >= 50) return false;
      if (complFilter === "50-80" && !(pct >= 50 && pct < 80)) return false;
      if (complFilter === "gte80" && pct < 80) return false;
      if (warnOnly && !(c.status === "failed" || dupIssueTags.has((c.client_tag || "").toUpperCase()) || isMissing(c))) return false;
      if (bucket !== "all" && startBucket(c.client_start_date) !== bucket) return false;
      return true;
    });
    const dir = sortDir === "asc" ? 1 : -1;
    return out.sort((a, b) => compareBy(a, b, sortKey) * dir || a.name.localeCompare(b.name));
  }, [campaigns, search, stages, status, classification, group, instanceFilter, tzFilter, complFilter, warnOnly, bucket, sortKey, sortDir, dupIssueTags, isMissing]);

  // Summary counts (reactive to filters).
  const summary = useMemo(() => {
    const active = filtered.filter((c) => c.status === "active").length;
    const main = filtered.filter((c) => /^main$/i.test(c.effective_stage || "")).length;
    const nurture = filtered.length - main;
    const leads = filtered.reduce((s, c) => s + (c.remaining_leads || 0), 0);
    return { total: filtered.length, active, main, nurture, remaining: leads };
  }, [filtered]);

  // ── Selection (click + drag) ───────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const dragging = useRef(false);
  const dragAdd = useRef(true);
  useEffect(() => {
    const up = () => { dragging.current = false; };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);
  const applyDrag = useCallback((k: string) => setSelected((s) => {
    const n = new Set(s);
    if (dragAdd.current) n.add(k); else n.delete(k);
    return n;
  }), []);
  const startDrag = useCallback((k: string) => {
    dragging.current = true;
    dragAdd.current = !selected.has(k);
    applyDrag(k);
  }, [selected, applyDrag]);
  const allSelected = filtered.length > 0 && filtered.every((c) => selected.has(keyOf(c)));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(filtered.map(keyOf)));
  const selectedRows = useMemo(() => filtered.filter((c) => selected.has(keyOf(c))), [filtered, selected]);

  const refresh = async () => { setRefreshing(true); try { await mutate(); } finally { setRefreshing(false); } };

  const runBulk = async (action: "pause" | "resume" | "archive") => {
    if (selectedRows.length === 0 || busy) return;
    if (!confirm(`${action[0].toUpperCase() + action.slice(1)} ${selectedRows.length} campaign${selectedRows.length === 1 ? "" : "s"}?`)) return;
    setBusy(true);
    try {
      for (let i = 0; i < selectedRows.length; i += 4) {
        await Promise.allSettled(selectedRows.slice(i, i + 4).map((c) =>
          fetch(`/api/campaigns/${c.id}/status?instance=${c.instance}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
          }),
        ));
      }
      setSelected(new Set());
      await mutate();
    } finally { setBusy(false); }
  };

  const toggleStage = (s: string) => setStages((prev) => {
    const n = new Set(prev);
    if (n.has(s)) n.delete(s); else n.add(s);
    return n;
  });
  const clearFilters = () => { setSearch(""); setStages(new Set()); setStatus("all"); setClassification("all"); setGroup("all"); setInstanceFilter("all"); setTzFilter("all"); setComplFilter("all"); setWarnOnly(false); setBucket("all"); };
  const anyFilter = search || stages.size || status !== "all" || classification !== "all" || group !== "all" || instanceFilter !== "all" || tzFilter !== "all" || complFilter !== "all" || warnOnly || bucket !== "all";

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="rounded-lg bg-primary/10 p-2"><Send className="h-5 w-5 text-primary" /></div>
        <div className="flex-1">
          <h1 className="text-lg font-semibold tracking-tight">Campaigns — Master Grid</h1>
          <p className="text-xs text-muted-foreground">One row per campaign across all selected instances · stage, status, completion & lead progress</p>
        </div>
        <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" onClick={refresh} disabled={refreshing}>
          {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
        </Button>
      </div>

      {/* Live duplication queue (renders only when there's activity) */}
      {isAdmin && <DuplicationQueuePanel />}

      {/* Summary chips */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
        <StatCard label="Campaigns" value={summary.total} />
        <StatCard label="Active" value={summary.active} accent="emerald" />
        <StatCard label="Main" value={summary.main} accent="primary" />
        <StatCard label="Nurture" value={summary.nurture} accent="violet" />
        <StatCard label="Remaining leads" value={summary.remaining.toLocaleString()} />
        <StatCard label="Dup queued" value={dupQueued} accent={dupQueued > 0 ? "primary" : undefined} />
        <StatCard label="Dup failed" value={dupFailed} accent={dupFailed > 0 ? "red" : undefined} />
        <StatCard label="Conn errors" value={connErrors} accent={connErrors > 0 ? "red" : undefined} />
      </div>

      {/* Toolbar */}
      <div className="rounded-xl border bg-card p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 w-56">
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or client tag…" className="flex-1 text-xs bg-transparent outline-none placeholder:text-muted-foreground" />
            {search && <button onClick={() => setSearch("")}><X className="h-3 w-3 text-muted-foreground hover:text-foreground" /></button>}
          </div>

          {/* Stage multi-select */}
          <div className="relative">
            <button onClick={() => setStageOpen((v) => !v)} className="flex items-center gap-1.5 rounded-lg border bg-background px-2.5 py-1.5 text-xs hover:bg-muted/40">
              Stage {stages.size > 0 && <span className="rounded-full bg-primary/15 text-primary px-1.5 text-[10px]">{stages.size}</span>}
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            </button>
            {stageOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setStageOpen(false)} />
                <div className="absolute z-40 mt-1 w-44 rounded-lg border bg-card shadow-lg p-1 max-h-64 overflow-y-auto">
                  {allStages.map((s) => (
                    <button key={s} onClick={() => toggleStage(s)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted/40">
                      <span className={`h-3.5 w-3.5 rounded border flex items-center justify-center ${stages.has(s) ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30"}`}>{stages.has(s) && <Check className="h-2.5 w-2.5" />}</span>
                      {s}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <Select value={status} onChange={setStatus} options={[["all", "All statuses"], ...allStatuses.map((s) => [s, s] as [string, string])]} />
          {allClasses.length > 0 && <Select value={classification} onChange={setClassification} options={[["all", "All classes"], ...allClasses.map((s) => [s, s] as [string, string])]} />}
          <Select value={group} onChange={setGroup} options={[["all", "All groups"], ["1", "Group 1"], ["2", "Group 2"]]} />
          {allInstances.length > 1 && <Select value={instanceFilter} onChange={setInstanceFilter} options={[["all", "All instances"], ...allInstances.map((s) => [s, INSTANCE_SHORT_LABELS[s as keyof typeof INSTANCE_SHORT_LABELS] || s] as [string, string])]} />}
          {allTimezones.length > 1 && <Select value={tzFilter} onChange={setTzFilter} options={[["all", "All timezones"], ...allTimezones.map((t) => [t, t.split("/").pop()!.replace(/_/g, " ")] as [string, string])]} />}
          <Select value={complFilter} onChange={setComplFilter} options={[["all", "All completion"], ["lt50", "< 50%"], ["50-80", "50–80%"], ["gte80", "≥ 80%"]]} />
          <button onClick={() => setWarnOnly((v) => !v)} className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs ${warnOnly ? "border-amber-500/50 bg-amber-500/10 text-amber-600" : "bg-background hover:bg-muted/40"}`}>
            <AlertTriangle className="h-3.5 w-3.5" /> Warnings
          </button>

          {anyFilter ? <Button variant="ghost" size="sm" className="h-8 text-xs gap-1" onClick={clearFilters}><X className="h-3.5 w-3.5" /> Clear</Button> : null}
        </div>

        {/* Start-date buckets */}
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="text-muted-foreground">Start-date group:</span>
          {[["all", "All"], ["1-14", "1st–14th"], ["15-eom", "15th–EOM"]].map(([v, l]) => (
            <button key={v} onClick={() => setBucket(v)}
              className={`rounded-md border px-2 py-0.5 ${bucket === v ? "bg-primary text-primary-foreground border-primary" : "border-muted-foreground/25 hover:bg-muted/50"} ${v === nowBucket && bucket !== v ? "ring-1 ring-primary/40" : ""}`}
              title={v === nowBucket ? "Current billing window" : undefined}>
              {l}{v === nowBucket ? " ●" : ""}
            </button>
          ))}
        </div>
      </div>

      {/* Selection action bar */}
      {isAdmin && selected.size > 0 && (
        <div className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card/95 backdrop-blur px-4 py-2.5 shadow-sm">
          <span className="text-xs font-medium">{selected.size} selected</span>
          <div className="flex items-center gap-2">
            <Button size="sm" className="h-7 text-xs gap-1.5" onClick={() => setDupOpen(true)}><Copy className="h-3 w-3" /> Duplicate</Button>
            <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={() => setSchedOpen(true)}><CalendarClock className="h-3 w-3" /> Schedule</Button>
            <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" disabled={busy} onClick={() => runBulk("resume")}><Play className="h-3 w-3" /> Resume</Button>
            <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" disabled={busy} onClick={() => runBulk("pause")}><Pause className="h-3 w-3" /> Pause</Button>
            <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" disabled={busy} onClick={() => runBulk("archive")}><Archive className="h-3 w-3" /> Archive</Button>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSelected(new Set())}>Clear</Button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="rounded-xl border bg-card overflow-hidden">
        {isLoading && campaigns.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-12">Loading campaigns…</div>
        ) : filtered.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-12">{campaigns.length === 0 ? "No campaigns synced yet." : "No campaigns match your filters."}</div>
        ) : (
          <div className="overflow-x-auto select-none">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] text-muted-foreground border-b">
                  <th className="w-[36px] px-3 py-2.5">
                    <button onClick={toggleAll} className={`h-4 w-4 rounded border flex items-center justify-center ${allSelected ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30 hover:border-foreground"}`}>{allSelected && <Check className="h-3 w-3" />}</button>
                  </th>
                  <STh label="Campaign" k="campaign" sk={sortKey} sd={sortDir} on={toggleSort} />
                  <STh label="Stage" k="stage" sk={sortKey} sd={sortDir} on={toggleSort} w="w-[100px]" />
                  <STh label="Class" k="class" sk={sortKey} sd={sortDir} on={toggleSort} w="w-[110px]" />
                  <STh label="Group" k="group" sk={sortKey} sd={sortDir} on={toggleSort} w="w-[70px]" />
                  <STh label="Instance" k="instance" sk={sortKey} sd={sortDir} on={toggleSort} w="w-[90px]" />
                  <STh label="Status" k="status" sk={sortKey} sd={sortDir} on={toggleSort} w="w-[100px]" />
                  <STh label="Remaining" k="remaining" sk={sortKey} sd={sortDir} on={toggleSort} align="right" w="w-[90px]" />
                  <STh label="Leads" k="leads" sk={sortKey} sd={sortDir} on={toggleSort} align="right" w="w-[90px]" />
                  <STh label="Completion" k="completion" sk={sortKey} sd={sortDir} on={toggleSort} w="w-[130px]" />
                  <STh label="Senders" k="senders" sk={sortKey} sd={sortDir} on={toggleSort} align="right" w="w-[70px]" />
                  <STh label="Schedule" k="schedule" sk={sortKey} sd={sortDir} on={toggleSort} w="w-[150px]" />
                  <STh label="Reply" k="reply" sk={sortKey} sd={sortDir} on={toggleSort} align="right" w="w-[80px]" />
                  <STh label="Start date" k="start" sk={sortKey} sd={sortDir} on={toggleSort} align="right" w="w-[100px]" />
                  <STh label="Go-live" k="golive" sk={sortKey} sd={sortDir} on={toggleSort} align="right" w="w-[100px]" />
                  <STh label="Created" k="created" sk={sortKey} sd={sortDir} on={toggleSort} align="right" w="w-[100px]" />
                  <th className="w-[36px]" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((c) => (
                  <Row key={keyOf(c)} c={c} selected={selected.has(keyOf(c))} warning={hasWarning(c) || isMissing(c)} missing={isMissing(c)}
                    onMouseDown={() => startDrag(keyOf(c))}
                    onMouseEnter={() => { if (dragging.current) applyDrag(keyOf(c)); }}
                    onOpen={() => setDetail(c)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">Showing {filtered.length} of {campaigns.length} campaigns · Automatically refreshes daily at 12:00 p.m. PT{lastUpdated ? ` · last updated ${new Date(lastUpdated).toLocaleString()}` : ""}</p>

      <DuplicateDialog open={dupOpen} onOpenChange={setDupOpen} selected={selectedRows} allCampaigns={campaigns} onQueued={() => { setSelected(new Set()); }} />
      <BulkScheduleDialog open={schedOpen} onOpenChange={setSchedOpen} selected={selectedRows} onDone={() => { mutate(); }} />
      <CampaignDetailDrawer campaign={detail} clientTags={activeClients} onClose={() => setDetail(null)} onSaved={() => mutate()} />
    </div>
  );
}

function Row({ c, selected, warning, missing, onMouseDown, onMouseEnter, onOpen }: { c: CampaignData; selected: boolean; warning: boolean; missing: boolean; onMouseDown: () => void; onMouseEnter: () => void; onOpen: () => void }) {
  const stage = c.effective_stage || "Main";
  const rr = c.total_leads_contacted > 0 ? (c.unique_replies / c.total_leads_contacted) * 100 : 0;
  const pct = Math.max(0, Math.min(100, c.completion_percentage || 0));
  const overridden = !!c.stage_override || !!c.client_tag_override;
  return (
    <tr className={`transition-colors cursor-pointer ${selected ? "bg-primary/5" : "hover:bg-muted/30"}`} onMouseDown={onMouseDown} onMouseEnter={onMouseEnter}>
      <td className="px-3 py-2.5">
        <div className={`h-4 w-4 rounded border flex items-center justify-center ${selected ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30"}`}>{selected && <Check className="h-3 w-3" />}</div>
      </td>
      <td className="px-3 py-2.5">
        <div className="font-medium select-text cursor-text leading-tight">{c.name}</div>
        <div className="text-[10px] text-muted-foreground truncate max-w-[280px]">
          {c.client_tag}{c.client_name ? <span className="text-muted-foreground/70"> · {c.client_name}</span> : null}
        </div>
      </td>
      <td className="px-3 py-2.5">
        <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${stageBadge(stage)}`}>
          {stage}{overridden && <span className="h-1 w-1 rounded-full bg-current opacity-60" title="manually corrected" />}
        </span>
      </td>
      <td className="px-3 py-2.5 text-[11px] text-muted-foreground">{c.classification || "—"}</td>
      <td className="px-3 py-2.5 text-[11px] text-muted-foreground">{c.group ? `G${c.group}` : "—"}</td>
      <td className="px-3 py-2.5"><span className="inline-flex items-center rounded-md border bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{INSTANCE_SHORT_LABELS[c.instance] || c.instance}</span></td>
      <td className="px-3 py-2.5">
        <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium capitalize ${STATUS_BADGE[c.status] || "bg-muted text-muted-foreground border-border"}`}>{c.status}</span>
        {missing && <span className="ml-1 text-[9px] text-destructive" title="No longer found in Bison (stale)">missing</span>}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums">{(c.remaining_leads || 0).toLocaleString()}</td>
      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{(c.total_leads || 0).toLocaleString()}</td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden"><div className="h-full bg-primary" style={{ width: `${pct}%` }} /></div>
          <span className="text-[10px] tabular-nums text-muted-foreground w-9 text-right">{pct.toFixed(0)}%</span>
        </div>
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-[11px] text-muted-foreground">{c.sender_count ?? "—"}</td>
      <td className="px-3 py-2.5 text-[11px] text-muted-foreground">
        {c.sched_start_time ? (
          <span title={c.sched_timezone || undefined}>{hhmm(c.sched_start_time)}–{hhmm(c.sched_end_time)} <span className="text-muted-foreground/60">{tzAbbr(c.sched_timezone)}</span></span>
        ) : "—"}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-[11px] text-muted-foreground">{rr.toFixed(1)}%</td>
      <td className="px-3 py-2.5 text-right text-[11px] text-muted-foreground tabular-nums">{c.client_start_date ? new Date(c.client_start_date).toLocaleDateString() : "—"}</td>
      <td className="px-3 py-2.5 text-right text-[11px] text-muted-foreground tabular-nums">{c.go_live_date ? new Date(c.go_live_date).toLocaleDateString() : "—"}</td>
      <td className="px-3 py-2.5 text-right text-[11px] text-muted-foreground tabular-nums">{c.created_at ? new Date(c.created_at).toLocaleDateString() : "—"}</td>
      <td className="px-2 py-2.5 text-right">
        <div className="flex items-center justify-end gap-1.5">
          {warning && <AlertTriangle className="h-3.5 w-3.5 text-amber-500" aria-label="warning" />}
          <button onMouseDown={(e) => e.stopPropagation()} onClick={onOpen} className="text-muted-foreground/50 hover:text-foreground" title="Details & history"><PanelRight className="h-3.5 w-3.5" /></button>
        </div>
      </td>
    </tr>
  );
}

function STh({ label, k, sk, sd, on, align, w }: { label: string; k: SortKey; sk: SortKey; sd: "asc" | "desc"; on: (k: SortKey) => void; align?: "right"; w?: string }) {
  const active = sk === k;
  return (
    <th className={`font-medium px-3 py-2.5 ${w || ""} ${align === "right" ? "text-right" : "text-left"}`}>
      <button onClick={() => on(k)} className={`inline-flex items-center gap-1 hover:text-foreground w-full ${align === "right" ? "justify-end" : "justify-start"} ${active ? "text-foreground" : ""}`}>
        {label}
        <ArrowUpDown className={`h-3 w-3 ${active ? "text-foreground" : "text-muted-foreground/40"} ${active && sd === "asc" ? "rotate-180" : ""}`} />
      </button>
    </th>
  );
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none text-xs rounded-lg border bg-background pl-2.5 pr-7 py-1.5 outline-none focus:ring-1 focus:ring-primary cursor-pointer"
      >
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string | number; accent?: "emerald" | "violet" | "primary" | "red" }) {
  const color = accent === "emerald" ? "text-emerald-500" : accent === "violet" ? "text-violet-500" : accent === "primary" ? "text-primary" : accent === "red" ? "text-destructive" : "text-foreground";
  return (
    <div className="rounded-xl border bg-card px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}
