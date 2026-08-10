"use client";

import { useMemo, useState, useRef, useEffect, useCallback } from "react";
import { Send, Search, X, RefreshCw, Loader2, Check, ChevronDown, Play, Pause, Archive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { useInstance } from "@/lib/instance-context";
import { useCampaigns, type CampaignData } from "@/lib/hooks/use-campaigns";
import { INSTANCE_SHORT_LABELS } from "@/lib/bison-instances";
import { stageOrder } from "@/lib/campaigns/stage";

const keyOf = (c: CampaignData) => `${c.instance}:${c.id}`;

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
  const { campaigns, isLoading, mutate } = useCampaigns(instancesQuery);

  const [search, setSearch] = useState("");
  const [stages, setStages] = useState<Set<string>>(new Set()); // empty = all
  const [status, setStatus] = useState("all");
  const [classification, setClassification] = useState("all");
  const [group, setGroup] = useState("all");
  const [instanceFilter, setInstanceFilter] = useState("all");
  const [bucket, setBucket] = useState("all");
  const [stageOpen, setStageOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const nowBucket = currentBucket();

  // Distinct filter option sources.
  const allStages = useMemo(() => Array.from(new Set(campaigns.map((c) => c.effective_stage || "Main"))).sort((a, b) => stageOrder(a) - stageOrder(b)), [campaigns]);
  const allStatuses = useMemo(() => Array.from(new Set(campaigns.map((c) => c.status))).filter(Boolean).sort(), [campaigns]);
  const allClasses = useMemo(() => Array.from(new Set(campaigns.map((c) => c.classification || "").filter(Boolean))).sort(), [campaigns]);
  const allInstances = useMemo(() => Array.from(new Set(campaigns.map((c) => c.instance))).sort(), [campaigns]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return campaigns.filter((c) => {
      if (q && !(`${c.name} ${c.client_tag}`.toLowerCase().includes(q))) return false;
      if (stages.size > 0 && !stages.has(c.effective_stage || "Main")) return false;
      if (status !== "all" && c.status !== status) return false;
      if (classification !== "all" && (c.classification || "") !== classification) return false;
      if (group !== "all" && String(c.group ?? "") !== group) return false;
      if (instanceFilter !== "all" && c.instance !== instanceFilter) return false;
      if (bucket !== "all" && startBucket(c.client_start_date) !== bucket) return false;
      return true;
    });
  }, [campaigns, search, stages, status, classification, group, instanceFilter, bucket]);

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
  const clearFilters = () => { setSearch(""); setStages(new Set()); setStatus("all"); setClassification("all"); setGroup("all"); setInstanceFilter("all"); setBucket("all"); };
  const anyFilter = search || stages.size || status !== "all" || classification !== "all" || group !== "all" || instanceFilter !== "all" || bucket !== "all";

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

      {/* Summary chips */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <StatCard label="Campaigns" value={summary.total} />
        <StatCard label="Active" value={summary.active} accent="emerald" />
        <StatCard label="Main" value={summary.main} accent="primary" />
        <StatCard label="Nurture" value={summary.nurture} accent="violet" />
        <StatCard label="Remaining leads" value={summary.remaining.toLocaleString()} />
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
                  <th className="text-left font-medium px-3 py-2.5">Campaign</th>
                  <th className="text-left font-medium px-3 py-2.5 w-[100px]">Stage</th>
                  <th className="text-left font-medium px-3 py-2.5 w-[110px]">Class</th>
                  <th className="text-left font-medium px-3 py-2.5 w-[90px]">Instance</th>
                  <th className="text-left font-medium px-3 py-2.5 w-[100px]">Status</th>
                  <th className="text-right font-medium px-3 py-2.5 w-[90px]">Remaining</th>
                  <th className="text-right font-medium px-3 py-2.5 w-[90px]">Leads</th>
                  <th className="text-left font-medium px-3 py-2.5 w-[130px]">Completion</th>
                  <th className="text-right font-medium px-3 py-2.5 w-[70px]">Senders</th>
                  <th className="text-left font-medium px-3 py-2.5 w-[150px]">Schedule</th>
                  <th className="text-right font-medium px-3 py-2.5 w-[80px]">Reply</th>
                  <th className="text-right font-medium px-3 py-2.5 w-[110px]">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((c) => (
                  <Row key={keyOf(c)} c={c} selected={selected.has(keyOf(c))}
                    onMouseDown={() => startDrag(keyOf(c))}
                    onMouseEnter={() => { if (dragging.current) applyDrag(keyOf(c)); }} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">Showing {filtered.length} of {campaigns.length} campaigns · Automatically refreshes daily at 12:00 p.m. PT</p>
    </div>
  );
}

function Row({ c, selected, onMouseDown, onMouseEnter }: { c: CampaignData; selected: boolean; onMouseDown: () => void; onMouseEnter: () => void }) {
  const stage = c.effective_stage || "Main";
  const replyRate = c.total_leads_contacted > 0 ? (c.unique_replies / c.total_leads_contacted) * 100 : 0;
  const pct = Math.max(0, Math.min(100, c.completion_percentage || 0));
  return (
    <tr className={`transition-colors cursor-pointer ${selected ? "bg-primary/5" : "hover:bg-muted/30"}`} onMouseDown={onMouseDown} onMouseEnter={onMouseEnter}>
      <td className="px-3 py-2.5">
        <div className={`h-4 w-4 rounded border flex items-center justify-center ${selected ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30"}`}>{selected && <Check className="h-3 w-3" />}</div>
      </td>
      <td className="px-3 py-2.5">
        <div className="font-medium select-text cursor-text leading-tight">{c.name}</div>
        {c.client_tag && <div className="text-[10px] text-muted-foreground">{c.client_tag}</div>}
      </td>
      <td className="px-3 py-2.5"><span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${stageBadge(stage)}`}>{stage}</span></td>
      <td className="px-3 py-2.5 text-[11px] text-muted-foreground">{c.classification || "—"}</td>
      <td className="px-3 py-2.5"><span className="inline-flex items-center rounded-md border bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{INSTANCE_SHORT_LABELS[c.instance] || c.instance}</span></td>
      <td className="px-3 py-2.5"><span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium capitalize ${STATUS_BADGE[c.status] || "bg-muted text-muted-foreground border-border"}`}>{c.status}</span></td>
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
      <td className="px-3 py-2.5 text-right tabular-nums text-[11px] text-muted-foreground">{replyRate.toFixed(1)}%</td>
      <td className="px-3 py-2.5 text-right text-[11px] text-muted-foreground tabular-nums">{c.created_at ? new Date(c.created_at).toLocaleDateString() : "—"}</td>
    </tr>
  );
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="text-xs rounded-lg border bg-background px-2.5 py-1.5 outline-none focus:ring-1 focus:ring-primary">
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string | number; accent?: "emerald" | "violet" | "primary" }) {
  const color = accent === "emerald" ? "text-emerald-500" : accent === "violet" ? "text-violet-500" : accent === "primary" ? "text-primary" : "text-foreground";
  return (
    <div className="rounded-xl border bg-card px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}
