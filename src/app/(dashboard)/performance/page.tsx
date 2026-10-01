"use client";

// Performance — beta base layer (Nick's Performance & Turbo Mode spec).
//
// One row per active tiered client: billing period, QL guarantee, QLs
// delivered, pace, projected, status, leaving, Turbo, throttle, actions.
// Underperforming / Overperforming / Overview views are filters over the same
// rows. The Turbo + throttle log sits below with a CSV export. Numbers come
// from the hourly sending-mode cron; actions hit /api/performance/*.

import { useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Download, Gauge, Rocket, Pause, Play, RotateCcw, Ban } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { usePerformance, type PerformanceClient, type SendingWindow } from "@/lib/hooks/use-performance";

type View = "under" | "over" | "all";

const STATUS_META: Record<string, { label: string; cls: string }> = {
  critical: { label: "Critical", cls: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/40" },
  at_risk: { label: "At Risk", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40" },
  on_track: { label: "On Track", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40" },
  overperforming: { label: "Overperforming", cls: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/40" },
  grace: { label: "Grace", cls: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-300 border-zinc-400/40" },
};

const fmtDate = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "—");
const pct = (p: number | null) => (p === null ? "—" : `${Math.round(p * 100)}%`);

function windowLabel(w: SendingWindow | null): string {
  if (!w) return "";
  if (w.status === "applying") return "applying…";
  if (w.status === "reverting") return "reverting…";
  if (w.status === "revert_failed") return "revert failed";
  return "";
}

async function post(url: string, body: Record<string, unknown>) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

export default function PerformancePage() {
  const { clients, windows, settings, evaluatedAt, isLoading, mutate } = usePerformance();
  const [view, setView] = useState<View>("under");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ client: PerformanceClient; accounts: number; byInstance: Record<string, number>; endsAt: string } | null>(null);

  const rows = useMemo(() => {
    const list = clients.filter((c) => {
      if (view === "under") return c.status === "at_risk" || c.status === "critical";
      if (view === "over") return c.status === "overperforming" || c.throttle;
      return true;
    });
    const rank: Record<string, number> = { critical: 0, at_risk: 1, overperforming: 2, on_track: 3, grace: 4 };
    return list.sort((a, b) =>
      (rank[a.status] ?? 9) - (rank[b.status] ?? 9)
      || (a.projected - a.guarantee) - (b.projected - b.guarantee)
      || a.daysRemaining - b.daysRemaining,
    );
  }, [clients, view]);

  const counts = useMemo(() => ({
    under: clients.filter((c) => c.status === "at_risk" || c.status === "critical").length,
    over: clients.filter((c) => c.status === "overperforming" || c.throttle).length,
    all: clients.length,
  }), [clients]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); await mutate(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
    finally { setBusy(null); }
  };

  const previewTurbo = (c: PerformanceClient) => run(`preview:${c.clientTag}`, async () => {
    const p = await post("/api/performance/turbo", { clientTag: c.clientTag, action: "preview" });
    if (p.accounts === 0) throw new Error(`${c.clientTag}: no connected accounts carry this tag`);
    setConfirm({ client: c, accounts: p.accounts, byInstance: p.byInstance, endsAt: p.endsAt });
  });

  const activateTurbo = () => {
    if (!confirm) return;
    const c = confirm.client;
    setConfirm(null);
    return run(`turbo:${c.clientTag}`, async () => {
      const r = await post("/api/performance/turbo", { clientTag: c.clientTag, action: "activate" });
      toast.success(`Turbo on for ${c.clientTag}: ${r.applied}/${r.accounts} accounts${r.failed ? `, ${r.failed} failed` : ""}${r.finished ? "" : " — finishing in the background"}`);
    });
  };

  const cancelTurbo = (c: PerformanceClient) => run(`turbo:${c.clientTag}`, async () => {
    const r = await post("/api/performance/turbo", { clientTag: c.clientTag, action: "cancel" });
    toast.success(`Turbo cancelled for ${c.clientTag}: ${r.reverted} restored${r.failed ? `, ${r.failed} still pending (cron retries)` : ""}`);
  });

  const throttle = (c: PerformanceClient, action: "pause" | "resume" | "release") => run(`throttle:${c.clientTag}`, async () => {
    await post("/api/performance/throttle", { clientTag: c.clientTag, action });
    toast.success(`${c.clientTag}: ${action === "pause" ? "auto-throttle paused" : action === "resume" ? "auto-throttle resumed" : "throttle released"}`);
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Performance"
        description="QL pace against each client's guarantee for their current billing period — Turbo Mode and auto-throttle"
      >
        {evaluatedAt && (
          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Gauge className="h-3.5 w-3.5" />
            evaluated {new Date(evaluatedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </PageHeader>

      {settings && (
        <p className="text-xs text-muted-foreground">
          Turbo: {settings.turboWarmupLimit} warm-up / {settings.turboDailyLimit} sending for {settings.turboDays} days ·
          Throttle: {settings.throttleDailyLimit} sending, on at {Math.round(settings.throttleOnPace * 100)}% pace, off below {Math.round(settings.throttleOffPace * 100)}% ·
          first {settings.graceDays} days of a period are not flagged
        </p>
      )}

      <div className="flex items-center gap-2">
        {([["under", "Underperforming"], ["over", "Overperforming"], ["all", "Overview"]] as [View, string][]).map(([v, label]) => (
          <Button key={v} size="sm" variant={view === v ? "default" : "outline"} onClick={() => setView(v)}>
            {label} <span className="ml-1 tabular-nums opacity-70">{counts[v]}</span>
          </Button>
        ))}
      </div>

      {isLoading ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : clients.length === 0 ? (
        <div className="rounded-xl border bg-muted/30 px-6 py-12 text-center">
          <Gauge className="h-8 w-8 text-muted-foreground/50 mx-auto mb-3" />
          <p className="text-sm font-medium">No pace data yet</p>
          <p className="text-xs text-muted-foreground mt-1">The sending-mode job runs hourly; rows appear after its first run.</p>
        </div>
      ) : (
        <div className="rounded-xl border bg-card overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-[11px] uppercase tracking-wide text-muted-foreground border-b">
              <tr>
                {["Client", "Billing period", "Days", "Guarantee", "QLs", "Pace", "Projected", "Status", "Leaving", "Turbo", "Throttle", "Action"].map((h) => (
                  <th key={h} className="text-left font-medium px-3 py-2 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const meta = STATUS_META[c.status] ?? STATUS_META.grace;
                const k = c.clientTag;
                const isBusy = busy?.endsWith(`:${k}`) ?? false;
                return (
                  <tr key={k} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <Link href={`/clients/${encodeURIComponent(k)}`} className="font-semibold hover:underline">{k}</Link>
                      {c.plan && <span className="text-muted-foreground"> · {c.plan}</span>}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap tabular-nums">{c.cycleStart} → {c.cycleEnd}</td>
                    <td className="px-3 py-2 whitespace-nowrap tabular-nums">{c.daysElapsed} / {c.daysRemaining} left</td>
                    <td className="px-3 py-2 tabular-nums">{c.guarantee}</td>
                    <td className="px-3 py-2 tabular-nums"><strong>{c.qlsDelivered}</strong> <span className="text-muted-foreground">/ {c.expectedToDate} exp.</span></td>
                    <td className="px-3 py-2 tabular-nums">{pct(c.pace)}</td>
                    <td className={`px-3 py-2 tabular-nums ${c.projected >= c.guarantee ? "text-emerald-600 dark:text-emerald-400" : ""}`}>{c.status === "grace" ? "—" : c.projected}</td>
                    <td className="px-3 py-2"><span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold ${meta.cls}`}>{meta.label}</span></td>
                    <td className="px-3 py-2 whitespace-nowrap">{c.leavingOn ? <span className="text-amber-600 dark:text-amber-400">Yes · {c.leavingKind} {c.leavingOn}</span> : "No"}</td>
                    <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                      {c.turbo ? <span className="text-violet-600 dark:text-violet-400">Active {fmtDate(c.turbo.started_at)} → {fmtDate(c.turbo.ends_at)} {windowLabel(c.turbo)}</span> : "—"}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                      {c.throttle ? <span className="text-sky-600 dark:text-sky-400">Throttled since {fmtDate(c.throttle.started_at)} {windowLabel(c.throttle)}</span> : c.autoThrottlePaused ? <span className="text-muted-foreground">Normal · auto paused</span> : "Normal"}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        {c.turbo ? (
                          <Button size="xs" variant="outline" disabled={isBusy} onClick={() => cancelTurbo(c)} title="End Turbo now and restore every account"><Ban className="h-3 w-3" /> Cancel Turbo</Button>
                        ) : (
                          <Button size="xs" variant="outline" disabled={isBusy || !!c.leavingOn} onClick={() => previewTurbo(c)} title={c.leavingOn ? "Client is leaving" : "Shift warm-up toward sending for 15 days"}><Rocket className="h-3 w-3" /> Turbo</Button>
                        )}
                        {c.throttle && (
                          <Button size="xs" variant="outline" disabled={isBusy} onClick={() => throttle(c, "release")} title="Release the throttle now"><RotateCcw className="h-3 w-3" /> Release</Button>
                        )}
                        {c.autoThrottlePaused ? (
                          <Button size="xs" variant="ghost" disabled={isBusy} onClick={() => throttle(c, "resume")} title="Let auto-throttle act on this client again"><Play className="h-3 w-3" /> Resume auto</Button>
                        ) : (
                          <Button size="xs" variant="ghost" disabled={isBusy} onClick={() => throttle(c, "pause")} title="Auto-throttle leaves this client alone"><Pause className="h-3 w-3" /> Pause auto</Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={12} className="px-3 py-6 text-center text-muted-foreground">No clients in this view.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Turbo &amp; throttle log</h2>
          <a href="/api/performance/windows?csv=1" className="text-xs inline-flex items-center gap-1 text-muted-foreground hover:underline">
            <Download className="h-3 w-3" /> Export CSV
          </a>
        </div>
        <div className="rounded-xl border bg-card overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-[11px] uppercase tracking-wide text-muted-foreground border-b">
              <tr>
                {["Client", "Kind", "Status", "Start", "End", "How it ended", "By", "Accounts", "Status / pace at start", "QLs start → end", "Emails sent", "Note"].map((h) => (
                  <th key={h} className="text-left font-medium px-3 py-2 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {windows.length === 0 && (
                <tr><td colSpan={12} className="px-3 py-6 text-center text-muted-foreground">No Turbo or throttle windows yet.</td></tr>
              )}
              {windows.map((w) => (
                <tr key={w.id} className="border-b last:border-0">
                  <td className="px-3 py-2 font-semibold">{w.client_tag}</td>
                  <td className="px-3 py-2 capitalize">{w.kind}</td>
                  <td className={`px-3 py-2 ${w.status === "revert_failed" ? "text-red-600 dark:text-red-400 font-semibold" : ""}`}>{w.status.replace("_", " ")}</td>
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums">{fmtDate(w.started_at)}</td>
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums">{fmtDate(w.ended_at ?? w.ends_at)}</td>
                  <td className="px-3 py-2">{w.end_reason ?? "—"}</td>
                  <td className="px-3 py-2">{w.activated_by ?? "—"}</td>
                  <td className="px-3 py-2 tabular-nums">{w.account_count}</td>
                  <td className="px-3 py-2 tabular-nums">{w.status_at_start ?? "—"} / {pct(w.pace_at_start)}</td>
                  <td className="px-3 py-2 tabular-nums">{w.qls_at_start ?? "—"} → {w.qls_at_end ?? "—"}</td>
                  <td className="px-3 py-2 tabular-nums">{w.sent_at_start !== null && w.sent_at_end !== null ? (w.sent_at_end - w.sent_at_start).toLocaleString() : "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground max-w-[260px] truncate" title={w.last_error ?? w.trigger_detail ?? ""}>{w.last_error ?? w.trigger_detail ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={!!confirm} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Activate Turbo for {confirm?.client.clientTag}?</DialogTitle>
            <DialogDescription>
              {confirm && (
                <>
                  {confirm.accounts} connected account(s) across{" "}
                  {Object.entries(confirm.byInstance).map(([i, n]) => `${i} (${n})`).join(", ")} go to{" "}
                  {settings?.turboWarmupLimit} warm-up / {settings?.turboDailyLimit} sending per day until{" "}
                  <strong>{fmtDate(confirm.endsAt)}</strong>, then back to exactly what each has now.
                  {confirm.client.throttle && " The active throttle is released first."}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button onClick={activateTurbo}><Rocket className="h-3.5 w-3.5" /> Activate Turbo</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
