"use client";

import { useEffect, useRef, useCallback } from "react";
import useSWR from "swr";
import { Copy, Loader2, CheckCircle2, AlertTriangle, Clock, RefreshCw, SkipForward, X, Ban } from "lucide-react";
import { INSTANCE_SHORT_LABELS } from "@/lib/bison-instances";
import { setRoleLabel } from "@/lib/campaigns/stage";

interface Item { id: number; sourceId: number; sourceName: string; setRole: string | null; status: string; newName: string | null; error: string | null }
interface Counts { total: number; queued: number; duplicating: number; done: number; failed: number; blocked: number; skipped: number }
interface TagGroup { clientTag: string; instance: string; items: Item[]; counts: Counts }
interface Job { jobId: string; submittedAt: string | null; tags: TagGroup[] }
interface Status { jobs: Job[]; totals: Counts; remaining: number; current: { clientTag: string; sourceName: string } | null }

const fetcher = (url: string) => fetch(url).then((r) => r.json());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function DuplicationQueuePanel() {
  const { data, mutate } = useSWR<Status>("/api/campaigns/duplicate", fetcher, { refreshInterval: 3000, revalidateOnFocus: true });
  const remaining = data?.remaining ?? 0;

  // Drive the queue from the browser while this panel is open (the cron backstop
  // covers the tab-closed case). Single-flight is enforced server-side.
  const drainingRef = useRef(false);
  const drainLoop = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      for (let i = 0; i < 300; i++) {
        const r = await fetch("/api/campaigns/duplicate/drain", { method: "POST" }).then((x) => x.json()).catch(() => null);
        await mutate();
        if (!r) { await sleep(3000); continue; }
        if (r.locked) { await sleep(2500); continue; }
        if (!r.more) break;
        await sleep(400);
      }
    } finally { drainingRef.current = false; }
  }, [mutate]);
  useEffect(() => { if (remaining > 0) drainLoop(); }, [remaining, drainLoop]);

  const act = async (body: Record<string, unknown>) => {
    await fetch("/api/campaigns/duplicate", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    await mutate();
    drainLoop();
  };

  if (!data || !Array.isArray(data.jobs) || data.jobs.length === 0) return null;
  const t = data.totals || { total: 0, queued: 0, duplicating: 0, done: 0, failed: 0, blocked: 0, skipped: 0 };
  const finishedAll = t.queued === 0 && t.duplicating === 0 && t.blocked === 0;
  const pct = t.total > 0 ? Math.round(((t.done + t.skipped) / t.total) * 100) : 0;

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b">
        <div className="flex items-center gap-2 min-w-0">
          <div className="rounded-lg bg-primary/10 p-1.5"><Copy className="h-4 w-4 text-primary" /></div>
          <div className="min-w-0">
            <div className="text-sm font-semibold flex items-center gap-2">
              Duplication queue
              {!finishedAll && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
            </div>
            <div className="text-[11px] text-muted-foreground truncate">
              {data.current ? <>Duplicating <span className="text-foreground font-medium">{data.current.sourceName}</span> · {data.current.clientTag}</>
                : finishedAll ? "All sets processed" : `${t.queued} waiting`}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="text-right">
            <div className="text-xs font-semibold tabular-nums">{t.done}/{t.total}</div>
            <div className="text-[10px] text-muted-foreground">{t.failed > 0 && <span className="text-destructive">{t.failed} failed · </span>}{pct}%</div>
          </div>
          {finishedAll && (
            <button onClick={() => act({ action: "dismiss-done" })} className="text-[11px] text-muted-foreground hover:text-foreground rounded-md border px-2 py-1">Clear finished</button>
          )}
        </div>
      </div>

      <div className="h-1 bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} /></div>

      <div className="max-h-80 overflow-y-auto divide-y">
        {data.jobs.flatMap((job) => (job.tags || []).map((g) => (
          <div key={`${job.jobId}:${g.instance}:${g.clientTag}`} className="px-4 py-2.5">
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold">{g.clientTag}</span>
                <span className="inline-flex items-center rounded border bg-muted/40 px-1 text-[9px] text-muted-foreground">{INSTANCE_SHORT_LABELS[g.instance as keyof typeof INSTANCE_SHORT_LABELS] || g.instance}</span>
                <TagState g={g} />
              </div>
              <span className="text-[10px] text-muted-foreground tabular-nums">{g.counts.done}/{g.counts.total}</span>
            </div>
            <div className="space-y-1">
              {(g.items || []).map((it) => (
                <div key={it.id} className="flex items-center gap-2 text-[11px]">
                  <StatusDot status={it.status} />
                  <span className="text-muted-foreground/60 w-[92px] shrink-0">{setRoleLabel(it.setRole)}</span>
                  <span className="flex-1 min-w-0 truncate" title={it.newName || it.sourceName}>{it.newName || it.sourceName}</span>
                  {it.status === "failed" && (
                    <span className="flex items-center gap-1 shrink-0">
                      <span className="text-destructive max-w-[180px] truncate" title={it.error || ""}>{it.error}</span>
                      <button onClick={() => act({ action: "retry", id: it.id })} className="inline-flex items-center gap-0.5 rounded border border-primary/40 text-primary px-1.5 py-0.5 hover:bg-primary/10"><RefreshCw className="h-2.5 w-2.5" />Retry</button>
                      <button onClick={() => act({ action: "skip", id: it.id })} className="inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-muted-foreground hover:bg-muted/50"><SkipForward className="h-2.5 w-2.5" />Skip</button>
                    </span>
                  )}
                  {it.status === "blocked" && <span className="text-amber-600 shrink-0">blocked</span>}
                </div>
              ))}
            </div>
          </div>
        )))}
      </div>
    </div>
  );
}

function TagState({ g }: { g: TagGroup }) {
  if (g.counts.failed > 0) return <span className="inline-flex items-center gap-0.5 text-[10px] text-destructive"><AlertTriangle className="h-3 w-3" />paused</span>;
  if (g.counts.duplicating > 0) return <span className="inline-flex items-center gap-0.5 text-[10px] text-primary"><Loader2 className="h-3 w-3 animate-spin" />running</span>;
  if (g.counts.queued > 0 || g.counts.blocked > 0) return <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground"><Clock className="h-3 w-3" />waiting</span>;
  return <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-500"><CheckCircle2 className="h-3 w-3" />done</span>;
}

function StatusDot({ status }: { status: string }) {
  if (status === "done") return <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />;
  if (status === "duplicating") return <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />;
  if (status === "failed") return <AlertTriangle className="h-3 w-3 text-destructive shrink-0" />;
  if (status === "blocked") return <Ban className="h-3 w-3 text-amber-500 shrink-0" />;
  if (status === "skipped") return <X className="h-3 w-3 text-muted-foreground/50 shrink-0" />;
  return <Clock className="h-3 w-3 text-muted-foreground/40 shrink-0" />;
}
