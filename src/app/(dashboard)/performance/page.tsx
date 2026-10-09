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
import { Download, Gauge, Rocket, Pause, Play, RotateCcw, Ban, AlertTriangle, Loader2, ChevronsDown } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { usePerformance, useThrottlePreview, type PerformanceClient, type SendingWindow, type TurboPreview } from "@/lib/hooks/use-performance";

type View = "under" | "over" | "nodata" | "all";

const STATUS_META: Record<string, { label: string; cls: string }> = {
  critical: { label: "Critical", cls: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/40" },
  at_risk: { label: "At Risk", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40" },
  on_track: { label: "On Track", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40" },
  overperforming: { label: "Overperforming", cls: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/40" },
  grace: { label: "Grace", cls: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-300 border-zinc-400/40" },
  no_data: { label: "No status data", cls: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-300 border-dashed border-zinc-400/60" },
};

// days_elapsed is counted to the Friday cut-off; the live day of the period
// is what the Days column shows.
const liveDay = (c: PerformanceClient) => c.cycleLength - c.daysRemaining;

/** "Grace" past the period's first days means no Friday cut-off has landed in
 *  this period yet — say so rather than calling it grace. */
function statusMeta(c: PerformanceClient, graceDays: number) {
  if (c.status === "grace" && liveDay(c) > graceDays) {
    return { label: "Waiting for Friday", cls: STATUS_META.grace.cls };
  }
  return STATUS_META[c.status] ?? STATUS_META.grace;
}

const BAND_LABEL: Record<string, string> = {
  target_met: "target met",
  credit_50: "50% credit",
  credit_100: "100% credit",
};
const fmtCutoff = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", timeZone: "America/Los_Angeles" });

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
  const { clients, windows, settings, evaluatedAt, judgedAt, isLoading, mutate } = usePerformance();
  const [view, setView] = useState<View>("under");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ client: PerformanceClient; preview: TurboPreview | null } | null>(null);

  const rows = useMemo(() => {
    const list = clients.filter((c) => {
      if (view === "under") return c.status === "at_risk" || c.status === "critical";
      if (view === "over") return c.status === "overperforming" || c.throttle;
      if (view === "nodata") return c.status === "no_data";
      return true;
    });
    const rank: Record<string, number> = { critical: 0, at_risk: 1, overperforming: 2, on_track: 3, no_data: 4, grace: 5 };
    return list.sort((a, b) =>
      (rank[a.status] ?? 9) - (rank[b.status] ?? 9)
      || (a.projected - a.guarantee) - (b.projected - b.guarantee)
      || a.daysRemaining - b.daysRemaining,
    );
  }, [clients, view]);

  const counts = useMemo(() => ({
    under: clients.filter((c) => c.status === "at_risk" || c.status === "critical").length,
    over: clients.filter((c) => c.status === "overperforming" || c.throttle).length,
    nodata: clients.filter((c) => c.status === "no_data").length,
    all: clients.length,
  }), [clients]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); await mutate(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
    finally { setBusy(null); }
  };

  // Opens straight away and fills in — the preview reads every account live
  // from Bison, which takes a few seconds on big clients.
  const previewTurbo = (c: PerformanceClient) => {
    setConfirm({ client: c, preview: null });
    return run(`preview:${c.clientTag}`, async () => {
      try {
        const p = (await post("/api/performance/turbo", { clientTag: c.clientTag, action: "preview" })) as TurboPreview;
        setConfirm((cur) => (cur?.client.clientTag === c.clientTag ? { client: c, preview: p } : cur));
      } catch (e) {
        setConfirm(null);
        throw e;
      }
    });
  };

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

      {judgedAt && (
        <p className="text-xs text-muted-foreground">
          QLs are counted up to <strong>{fmtCutoff(judgedAt)} PST</strong>, the last Friday 5 PM — the team fills the Status
          column by then, so mid-week numbers would read behind. &quot;No status data&quot; = most of this period&apos;s replies still
          have no Status, so the client can&apos;t be judged.
        </p>
      )}

      {settings && (
        <p className="text-xs text-muted-foreground">
          Turbo: {settings.turboWarmupLimit} warm-up / {settings.turboDailyLimit} sending for {settings.turboDays} days ·
          Throttle: {settings.throttleDailyLimit} sending, on at {Math.round(settings.throttleOnPace * 100)}% pace, off below {Math.round(settings.throttleOffPace * 100)}% ·
          first {settings.graceDays} days of a period are not flagged
        </p>
      )}

      <div className="flex items-center gap-2">
        {([["under", "Underperforming"], ["over", "Overperforming"], ["nodata", "No status data"], ["all", "Overview"]] as [View, string][]).map(([v, label]) => (
          <Button key={v} size="sm" variant={view === v ? "default" : "outline"} onClick={() => setView(v)}>
            {label} <span className="ml-1 tabular-nums opacity-70">{counts[v]}</span>
          </Button>
        ))}
      </div>

      {view === "over" && <ThrottlePreviewCard />}

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
                const meta = statusMeta(c, settings?.graceDays ?? 5);
                const k = c.clientTag;
                const isBusy = busy?.endsWith(`:${k}`) ?? false;
                return (
                  <tr key={k} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <Link href={`/clients/${encodeURIComponent(k)}`} className="font-semibold hover:underline">{k}</Link>
                      {c.plan && <span className="text-muted-foreground"> · {c.plan}</span>}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap tabular-nums">{c.cycleStart} → {c.cycleEnd}</td>
                    <td className="px-3 py-2 whitespace-nowrap tabular-nums">day {liveDay(c)} · {c.daysRemaining} left</td>
                    <td className="px-3 py-2 tabular-nums">{c.guarantee}</td>
                    <td className="px-3 py-2 tabular-nums"><strong>{c.qlsDelivered}</strong> <span className="text-muted-foreground">/ {c.expectedToDate} exp.</span></td>
                    <td className="px-3 py-2 tabular-nums">{pct(c.pace)}</td>
                    <td className={`px-3 py-2 tabular-nums ${c.projected >= c.guarantee ? "text-emerald-600 dark:text-emerald-400" : ""}`}>{c.status === "grace" || c.status === "no_data" ? "—" : c.projected}</td>
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
                          <Button size="xs" variant="outline" disabled={isBusy || !!c.leavingOn} onClick={() => previewTurbo(c)} title={c.leavingOn ? "Client is leaving" : "See what Turbo would change before turning it on"}><Rocket className="h-3 w-3" /> Turbo</Button>
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
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Turbo preview: {confirm?.client.clientTag}</DialogTitle>
            <DialogDescription>Nothing changes until you press Activate.</DialogDescription>
          </DialogHeader>
          {confirm && !confirm.preview && (
            <div className="flex items-center gap-2 py-8 justify-center text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Reading accounts and campaigns…
            </div>
          )}
          {confirm?.preview && <TurboPreviewBody p={confirm.preview} />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              onClick={activateTurbo}
              disabled={!confirm?.preview || confirm.preview.accounts.total === 0 || confirm.preview.open?.kind === "turbo"}
            >
              <Rocket className="h-3.5 w-3.5" /> Activate Turbo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TurboPreviewBody({ p }: { p: TurboPreview }) {
  const { standing, accounts, perDay, estimate, settings } = p;
  const n = (v: number) => v.toLocaleString();
  return (
    <div className="space-y-4 text-sm">
      {standing && (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Where they stand</h3>
          <p>
            <strong>{standing.qlsDelivered} of {standing.guarantee}</strong> QLs so far (counted to {fmtCutoff(standing.judgedAt)} PST).
            {standing.status === "no_data" ? (
              <> Most replies have no Status yet, so the real number isn&apos;t known.</>
            ) : (
              <> On this pace: <strong>{standing.projected}</strong> by {standing.cycleEnd} → <strong>{BAND_LABEL[standing.band]}</strong>.</>
            )}
          </p>
        </section>
      )}

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
          What changes for {settings.turboDays} days (until {fmtDate(p.endsAt)})
        </h3>
        <ul className="list-disc pl-5 space-y-0.5">
          <li><strong>{n(accounts.raised)}</strong> account(s) go up to <strong>{settings.turboDailyLimit} sends/day</strong>.</li>
          {accounts.unchanged > 0 && <li>{n(accounts.unchanged)} already send {settings.turboDailyLimit}+/day and stay as they are.</li>}
          <li>Warm-up comes down to {settings.turboWarmupLimit}/day, so more of each account goes to real sending.</li>
          <li className="text-muted-foreground">{accounts.byInstance.map((b) => `${b.label} (${n(b.count)})`).join(" · ") || "No connected accounts"}</li>
        </ul>
      </section>

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Impact (rough estimate)</h3>
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg border px-3 py-2">
            <div className="text-[11px] text-muted-foreground">Sends per day</div>
            <div className="tabular-nums font-semibold">{n(perDay.now)} → {n(perDay.turbo)}</div>
            <div className="text-[11px] text-emerald-600 dark:text-emerald-400 tabular-nums">+{n(perDay.extra)}/day</div>
          </div>
          <div className="rounded-lg border px-3 py-2">
            <div className="text-[11px] text-muted-foreground">Extra emails this period</div>
            <div className="tabular-nums font-semibold">+{n(estimate.extraEmailsInPeriod)}</div>
            <div className="text-[11px] text-muted-foreground">{estimate.turboDaysInPeriod} Turbo day(s) left in it</div>
          </div>
          <div className="rounded-lg border px-3 py-2">
            <div className="text-[11px] text-muted-foreground">Extra QLs</div>
            <div className="tabular-nums font-semibold">{estimate.extraQls === null ? "—" : `≈ +${estimate.extraQls}`}</div>
            <div className="text-[11px] text-muted-foreground">
              {estimate.projectedWithTurbo !== null && estimate.bandWithTurbo
                ? `→ ${estimate.projectedWithTurbo} · ${BAND_LABEL[estimate.bandWithTurbo]}`
                : "not enough history"}
            </div>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground mt-1.5">
          {estimate.emailsPerQl
            ? `From this client's history: about 1 QL per ${n(estimate.emailsPerQl)} emails. `
            : ""}
          Sends per day = what the connected accounts allow, within the {perDay.activeCampaigns} sending campaign(s)&apos; daily caps.
          Replies arrive days after the send, so treat the QL number as a rough guide.
        </p>
      </section>

      {p.warnings.length > 0 && (
        <section className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
          <h3 className="text-xs font-semibold text-amber-700 dark:text-amber-300 flex items-center gap-1 mb-1">
            <AlertTriangle className="h-3.5 w-3.5" /> Watch out
          </h3>
          <ul className="list-disc pl-5 space-y-0.5 text-xs">
            {p.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </section>
      )}

      <p className="text-xs text-muted-foreground">
        On {fmtDate(p.endsAt)} every account goes back to exactly the limits it has today, automatically. You can cancel Turbo any time.
      </p>
    </div>
  );
}

function ThrottlePreviewCard() {
  const { preview: p, error, isLoading, mutate } = useThrottlePreview(true);
  const [confirmSwitch, setConfirmSwitch] = useState<boolean | null>(null); // target state being confirmed
  const [switching, setSwitching] = useState(false);
  const n = (v: number) => v.toLocaleString();

  const flip = async (enabled: boolean) => {
    setSwitching(true);
    try {
      await post("/api/performance/auto-throttle", { enabled });
      toast.success(enabled ? "Auto-throttle is ON — it acts at the next daily run" : "Auto-throttle is OFF — nobody new will be throttled");
      setConfirmSwitch(null);
      await mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setSwitching(false);
    }
  };
  const changedBy = p?.settings.autoThrottleUpdatedBy
    ? `${p.settings.autoThrottleEnabled ? "Turned on" : "Turned off"} by ${p.settings.autoThrottleUpdatedBy}${p.settings.autoThrottleUpdatedAt ? ` · ${fmtDate(p.settings.autoThrottleUpdatedAt)}` : ""}`
    : null;
  const nextPass = p
    ? new Date(p.nextPassAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "";
  return (
    <div className="rounded-xl border bg-card p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <ChevronsDown className="h-4 w-4 text-sky-600 dark:text-sky-400" />
        <h2 className="text-sm font-semibold">Auto-throttle preview</h2>
        {p && (
          p.enabled
            ? <span className="rounded-full border border-sky-500/40 bg-sky-500/15 px-2 py-0.5 text-[10px] font-semibold text-sky-700 dark:text-sky-300">ON · next run {nextPass}</span>
            : <span className="rounded-full border border-zinc-400/40 bg-zinc-500/10 px-2 py-0.5 text-[10px] font-semibold text-zinc-600 dark:text-zinc-300">OFF · preview only, nothing changes</span>
        )}
        {changedBy && <span className="text-[11px] text-muted-foreground">{changedBy}</span>}
        {p && (
          <Button
            size="sm"
            variant={p.enabled ? "outline" : "default"}
            className="ml-auto"
            disabled={switching}
            onClick={() => setConfirmSwitch(!p.enabled)}
          >
            {p.enabled ? "Turn auto-throttle off" : "Turn auto-throttle on"}
          </Button>
        )}
      </div>
      {p && (
        <p className="text-xs text-muted-foreground">
          A client at {Math.round(p.settings.throttleOnPace * 100)}%+ of its QL pace (and still projected to hit its target) has its accounts
          lowered to <strong>{p.settings.throttleDailyLimit} sends/day</strong>, so it doesn&apos;t burn through leads and domains faster than it needs.
          It goes back to normal by itself when pace drops below {Math.round(p.settings.throttleOffPace * 100)}%, the projection falls under target,
          a new billing month starts, or the client is leaving. Accounts already at {p.settings.throttleDailyLimit}/day or less aren&apos;t touched,
          and a client is never throttled if the estimate says it would end the month under target.
        </p>
      )}

      {isLoading && !p && <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Working out what it would do…</div>}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error.message}</p>}

      {p && (
        <>
          <p className="text-sm">
            {p.throttle.length === 0
              ? "The next run would throttle no one."
              : <>The next run would throttle <strong>{p.throttle.length}</strong> client(s), <strong>{n(p.throttle.reduce((s, r) => s + r.fewerPerDay, 0))}</strong> fewer emails/day in total.</>}
          </p>
          {p.throttle.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-[11px] uppercase tracking-wide text-muted-foreground border-b">
                  <tr>
                    {["Client", "QLs / target", "Pace", "Projected", "Accounts lowered", "Sends / day", "QLs given up (est.)", "Projected after"].map((h) => (
                      <th key={h} className="text-left font-medium px-2 py-1.5 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {p.throttle.map((r) => (
                    <tr key={r.clientTag} className="border-b last:border-0">
                      <td className="px-2 py-1.5 font-semibold whitespace-nowrap">{r.clientTag}</td>
                      <td className="px-2 py-1.5 tabular-nums">{r.qlsDelivered} / {r.guarantee}</td>
                      <td className="px-2 py-1.5 tabular-nums">{pct(r.pace)}</td>
                      <td className="px-2 py-1.5 tabular-nums">{r.projected}</td>
                      <td className="px-2 py-1.5 tabular-nums">{n(r.lowered)} of {n(r.accounts)}</td>
                      <td className="px-2 py-1.5 tabular-nums whitespace-nowrap">{n(r.perDayNow)} → {n(r.perDayThrottled)} <span className="text-muted-foreground">(−{n(r.fewerPerDay)})</span></td>
                      <td className="px-2 py-1.5 tabular-nums">≈ {r.qlsGivenUp}</td>
                      <td className="px-2 py-1.5 tabular-nums">{r.projectedAfter}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {p.release.length > 0 && (
            <p className="text-xs"><strong>Back to normal:</strong> {p.release.map((r) => `${r.clientTag} (${r.reason.replaceAll("_", " ")})`).join(", ")}</p>
          )}
          {p.leftAlone.length > 0 && (
            <p className="text-xs text-muted-foreground"><strong>Over the line but left alone:</strong> {p.leftAlone.map((r) => `${r.clientTag} (${r.reason})`).join(", ")}</p>
          )}
          <p className="text-[11px] text-muted-foreground">
            &quot;QLs given up&quot; assumes the throttle stays on to the end of the billing month and the QLs still to come shrink with sending — a rough guide.
            Account numbers come from the dashboard&apos;s copy of Bison; the run applies the limits to Bison live.
          </p>
        </>
      )}

      <Dialog open={confirmSwitch !== null} onOpenChange={(o) => { if (!o) setConfirmSwitch(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmSwitch ? "Turn auto-throttle on?" : "Turn auto-throttle off?"}</DialogTitle>
            <DialogDescription>
              {confirmSwitch
                ? <>From the next daily run ({nextPass}) it lowers over-pacing clients to {p?.settings.throttleDailyLimit} sends/day by itself, and puts them back when they&apos;re near target.</>
                : <>Nobody new gets throttled. Clients already throttled stay that way until the normal rules release them, or you press Release on their row.</>}
            </DialogDescription>
          </DialogHeader>
          {confirmSwitch && p && (
            <div className="text-sm">
              {p.throttle.length === 0
                ? <p>Right now it would throttle no one.</p>
                : <>
                    <p className="mb-1">If it ran now, it would throttle <strong>{p.throttle.length}</strong> client(s) (−{n(p.throttle.reduce((s2, r) => s2 + r.fewerPerDay, 0))} emails/day):</p>
                    <p className="text-xs text-muted-foreground">{p.throttle.map((r) => `${r.clientTag} (${pct(r.pace)})`).join(", ")}</p>
                  </>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmSwitch(null)}>Cancel</Button>
            <Button disabled={switching} onClick={() => confirmSwitch !== null && flip(confirmSwitch)}>
              {switching && <Loader2 className="h-3.5 w-3.5 animate-spin" />} {confirmSwitch ? "Turn on" : "Turn off"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
