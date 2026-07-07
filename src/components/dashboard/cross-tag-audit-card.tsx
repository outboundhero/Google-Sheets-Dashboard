"use client";

// Dashboard widget: domains attached to campaigns that DON'T match their client
// tag (cross-client contamination). Run the audit (chunked Bison crawl), then
// drag-select / select-all the domains to strip out of the wrong-client
// campaigns. Removal is per-domain with error handling; a cleaned domain drops
// off. Collapsible. Admin-only.
import { useState, useEffect, useRef, useCallback } from "react";
import { ChevronDown, ChevronRight, RefreshCw, Loader2, AlertTriangle, Trash2 } from "lucide-react";

interface WrongCampaign { id: number; name: string; status: string; clientTag: string; instance: string }
interface FlaggedDomain { instance: string; domain: string; clientTag: string; wrongCampaigns: WrongCampaign[] }

const short: Record<string, string> = { outboundhero: "B2B1·OH", cleaningoutbound: "B2C1·CO", facilityreach: "B2B2·FR", outboundclean: "B2C2·OC" };
const RUN_BATCH = 50;
// Campaign jobs per removal request. The FE dedups the whole selection down
// to unique campaigns first (the same ~200 campaigns repeat across thousands
// of flagged domains) — each request processes a slice of those, so progress
// ticks every batch and each campaign is cleaned exactly once. Server-side
// each campaign is ~4-6 Bison calls (status → pause → remove rounds →
// resume). Kept small enough that a batch stays under Vercel's 300s limit
// even when Bison rate-limits and the server waits out full windows.
const CAMPAIGN_BATCH = 12;

export function CrossTagAuditCard() {
  const [open, setOpen] = useState(false);
  const [flagged, setFlagged] = useState<FlaggedDomain[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [runProgress, setRunProgress] = useState<{ done: number; total: number; found: number } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeProgress, setRemoveProgress] = useState<{ done: number; total: number; current: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per-campaign failures from the last removal run — rendered as a clean
  // dismissible list instead of being silently folded into a counter.
  const [failures, setFailures] = useState<{ name: string; instance: string; error: string }[]>([]);

  const dragging = useRef(false);
  const dragAdd = useRef(true);

  const key = (f: FlaggedDomain) => `${f.instance}:${f.domain}`;

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/replacement/cross-tag-audit", { cache: "no-store" });
      const d = await res.json();
      if (res.ok) setFlagged(d.flagged || []);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const up = () => { dragging.current = false; };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const applyDrag = (k: string) => setSelected((s) => {
    const n = new Set(s);
    if (dragAdd.current) n.add(k); else n.delete(k);
    return n;
  });
  const startDrag = (k: string) => { dragging.current = true; dragAdd.current = !selected.has(k); applyDrag(k); };

  const runAudit = async () => {
    setRunning(true); setError(null); setSelected(new Set()); setFailures([]);
    let failedBatches = 0;
    try {
      const res = await fetch("/api/replacement/cross-tag-audit?list=domains", { cache: "no-store" });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Failed to load domains");
      const domains: { instance: string; domain: string }[] = d.domains || [];
      let found = 0;
      setRunProgress({ done: 0, total: domains.length, found: 0 });
      for (let i = 0; i < domains.length; i += RUN_BATCH) {
        const batch = domains.slice(i, i + RUN_BATCH);
        try {
          const r = await fetch("/api/replacement/cross-tag-audit", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ domains: batch, reset: i === 0 }),
          });
          const text = await r.text();
          let rd: { flaggedCount?: number; error?: string } | null = null;
          try { rd = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
          if (!rd || !r.ok || rd.error) failedBatches++;
          else found += rd.flaggedCount || 0;
        } catch { failedBatches++; }
        setRunProgress({ done: Math.min(i + RUN_BATCH, domains.length), total: domains.length, found });
        if (i % (RUN_BATCH * 5) === 0) await load(); // periodic refresh
      }
      await load();
      if (failedBatches > 0) {
        setError(`${failedBatches} audit batch${failedBatches === 1 ? "" : "es"} failed — results may be incomplete. Run the audit again to fill the gaps.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Audit failed");
    } finally {
      // Never leave the card stuck.
      setRunning(false);
      setRunProgress(null);
    }
  };

  // Campaign-centric bulk removal. The FE dedups the whole selection down to
  // UNIQUE campaigns (the same ~200 campaigns repeat across thousands of
  // flagged domains) and sends them in batches — server-side each campaign is
  // paused (Bison only removes senders from draft/paused campaigns), the
  // candidate inbox IDs are submitted blind to Bison's async deletion queue
  // (no sender-list crawling), then resumed. Domains whose every campaign
  // succeeded are bulk-cleared at the end.
  const removeSelected = async () => {
    const targets = flagged.filter((f) => selected.has(key(f)));
    if (targets.length === 0) return;
    setRemoving(true); setError(null); setFailures([]);

    // Group by unique (instance, campaign).
    interface Job { instance: string; id: number; name: string; status: string; domains: string[] }
    const jobMap = new Map<string, Job>();
    for (const f of targets) {
      for (const c of f.wrongCampaigns) {
        const jk = `${f.instance}:${c.id}`;
        let job = jobMap.get(jk);
        if (!job) { job = { instance: f.instance, id: c.id, name: c.name, status: c.status, domains: [] }; jobMap.set(jk, job); }
        job.domains.push(f.domain);
      }
    }
    const jobList = [...jobMap.values()];
    const failedJobKeys = new Set<string>();
    const collectedFailures: { name: string; instance: string; error: string }[] = [];
    const chunkErrors: string[] = [];
    let removedTotal = 0;

    setRemoveProgress({ done: 0, total: jobList.length, current: `${jobList.length} unique campaigns across ${targets.length} domains` });
    const startedAt = Date.now();
    try {
      for (let i = 0; i < jobList.length; i += CAMPAIGN_BATCH) {
        const batch = jobList.slice(i, i + CAMPAIGN_BATCH);
        try {
          const res = await fetch("/api/replacement/cross-tag-remove", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ campaigns: batch }),
          });
          // JSON-safe parse: a Vercel timeout returns an HTML page, not JSON.
          const text = await res.text();
          let d: { error?: string; removed?: number; results?: { instance: string; campaignId: number; name: string; ok: boolean; removed: number; error?: string }[] } | null = null;
          try { d = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
          if (!d || !res.ok || d.error) {
            const why = !d
              ? (res.status >= 500 ? "server timed out or crashed" : `non-JSON response (HTTP ${res.status})`)
              : (d.error || `HTTP ${res.status}`);
            chunkErrors.push(`Batch ${Math.floor(i / CAMPAIGN_BATCH) + 1}: ${why}`);
            for (const j of batch) failedJobKeys.add(`${j.instance}:${j.id}`);
          } else {
            removedTotal += d.removed || 0;
            for (const r of d.results || []) {
              if (!r.ok) {
                failedJobKeys.add(`${r.instance}:${r.campaignId}`);
                collectedFailures.push({ name: r.name, instance: r.instance, error: r.error || "failed" });
              }
            }
          }
        } catch (e) {
          chunkErrors.push(`Batch ${Math.floor(i / CAMPAIGN_BATCH) + 1}: ${e instanceof Error ? e.message : "network error"}`);
          for (const j of batch) failedJobKeys.add(`${j.instance}:${j.id}`);
        }
        // Surface failures + errors LIVE, not just at the end of the run —
        // the red panels below update after every batch.
        setFailures([...collectedFailures]);
        if (chunkErrors.length) setError(chunkErrors.join(" · "));

        const done = Math.min(i + CAMPAIGN_BATCH, jobList.length);
        const elapsed = (Date.now() - startedAt) / 1000;
        const etaSec = done > 0 ? Math.round((elapsed / done) * (jobList.length - done)) : 0;
        const eta = etaSec >= 60 ? `~${Math.ceil(etaSec / 60)}m left` : `~${etaSec}s left`;
        setRemoveProgress({
          done,
          total: jobList.length,
          current: `${removedTotal.toLocaleString()} inbox removals queued · ${eta}${collectedFailures.length ? ` · ${collectedFailures.length} campaigns failed` : ""}`,
        });
      }

      // Clear domains whose every wrong campaign succeeded; failures stay
      // flagged so a re-run retries exactly what's left.
      const clearable = targets.filter((f) =>
        f.wrongCampaigns.every((c) => !failedJobKeys.has(`${f.instance}:${c.id}`)),
      );
      setRemoveProgress({ done: jobList.length, total: jobList.length, current: `clearing ${clearable.length} cleaned domains…` });
      for (let i = 0; i < clearable.length; i += 500) {
        try {
          await fetch("/api/replacement/cross-tag-remove", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "clearDomains",
              domains: clearable.slice(i, i + 500).map((f) => ({ instance: f.instance, domain: f.domain })),
            }),
          });
        } catch { /* rows stay; harmless — next audit reconciles */ }
      }
    } finally {
      // Never leave the card stuck — buttons re-enable no matter what threw.
      setRemoving(false);
      setRemoveProgress(null);
    }
    if (chunkErrors.length) setError(chunkErrors.join(" · "));
    setFailures(collectedFailures);
    setSelected(new Set());
    await load();
  };

  const busy = running || removing;

  return (
    <div className="rounded-xl border bg-card">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-2 px-5 py-3 text-left">
        {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
        <span className="text-sm font-medium">Domains in wrong-client campaigns</span>
        {flagged.length > 0 && <span className="text-xs rounded-full bg-amber-500/15 text-amber-500 px-2 py-0.5">{flagged.length}</span>}
        <span className="ml-auto text-[11px] text-muted-foreground">cross-client contamination · {open ? "collapse" : "expand"}</span>
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">
              Flags domains whose inboxes sit in campaigns belonging to a <b>different</b> client tag. Run the audit, then select which to strip out.
            </p>
            <button onClick={runAudit} disabled={busy} className="flex items-center gap-1.5 text-xs rounded-md border px-2.5 py-1.5 hover:bg-muted/50 disabled:opacity-50 shrink-0">
              <RefreshCw className={`h-3.5 w-3.5 ${running ? "animate-spin" : ""}`} />
              {running ? "Auditing…" : "Run audit"}
            </button>
          </div>

          {runProgress && (
            <div className="space-y-1">
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>Scanning {runProgress.done}/{runProgress.total} domains</span>
                <span className="text-amber-500">{runProgress.found} flagged</span>
              </div>
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div className="h-full bg-amber-500 transition-all" style={{ width: `${runProgress.total ? (runProgress.done / runProgress.total) * 100 : 0}%` }} />
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span className="flex-1">{error}</span>
              <button onClick={() => setError(null)} className="shrink-0 opacity-60 hover:opacity-100" title="Dismiss">✕</button>
            </div>
          )}

          {/* Per-campaign failures from the last removal — the affected domains
              stay flagged in the list below, so re-running Remove retries them. */}
          {failures.length > 0 && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5">
              <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-destructive font-medium">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {failures.length} campaign{failures.length === 1 ? "" : "s"} failed — their domains stay flagged, re-run Remove to retry
                <button onClick={() => setFailures([])} className="ml-auto opacity-60 hover:opacity-100" title="Dismiss">✕</button>
              </div>
              <div className="max-h-36 overflow-y-auto divide-y divide-destructive/10 border-t border-destructive/20">
                {failures.slice(0, 30).map((f, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-1 text-[11px]">
                    <span className="font-medium truncate max-w-[240px]">{f.name}</span>
                    <span className="text-muted-foreground shrink-0">{short[f.instance] ?? f.instance}</span>
                    <span className="text-destructive/80 truncate">{f.error}</span>
                  </div>
                ))}
                {failures.length > 30 && (
                  <div className="px-3 py-1 text-[11px] text-muted-foreground">…and {failures.length - 30} more</div>
                )}
              </div>
            </div>
          )}

          {flagged.length === 0 && !running ? (
            <p className="text-sm text-emerald-600 dark:text-emerald-400">No cross-client contamination found. ✓</p>
          ) : flagged.length > 0 && (
            <>
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-3">
                  <button onClick={() => setSelected(new Set(flagged.map(key)))} className="text-primary hover:underline">Select all</button>
                  <button onClick={() => setSelected(new Set())} className="text-muted-foreground hover:text-foreground">Clear</button>
                  <span className="text-muted-foreground">{selected.size} selected</span>
                </div>
                <button
                  onClick={removeSelected}
                  disabled={busy || selected.size === 0}
                  className="flex items-center gap-1.5 rounded-md bg-destructive/90 text-destructive-foreground px-2.5 py-1.5 hover:bg-destructive disabled:opacity-40"
                >
                  {removing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  Remove from wrong campaigns
                </button>
              </div>

              {removeProgress && (
                <div className="space-y-1">
                  <div className="flex justify-between text-[11px] text-muted-foreground">
                    <span>Cleaning campaign {removeProgress.done}/{removeProgress.total}</span>
                    <span className="truncate max-w-[320px]">{removeProgress.current}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div className="h-full bg-primary transition-all" style={{ width: `${removeProgress.total ? (removeProgress.done / removeProgress.total) * 100 : 0}%` }} />
                  </div>
                </div>
              )}

              <div className="rounded-lg border divide-y max-h-[420px] overflow-y-auto select-none">
                {flagged.map((f) => {
                  const k = key(f);
                  const sel = selected.has(k);
                  return (
                    <div
                      key={k}
                      onMouseDown={() => startDrag(k)}
                      onMouseEnter={() => { if (dragging.current) applyDrag(k); }}
                      className={`flex items-start gap-3 px-3 py-2 cursor-pointer ${sel ? "bg-primary/5" : "hover:bg-muted/40"}`}
                    >
                      <div className={`mt-0.5 h-4 w-4 rounded border flex items-center justify-center shrink-0 ${sel ? "bg-primary border-primary" : "border-muted-foreground/30"}`}>
                        {sel && <div className="h-2 w-2 rounded-sm bg-primary-foreground" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-medium truncate">{f.domain}</span>
                          <span className="text-emerald-500 shrink-0">{f.clientTag}</span>
                          <span className="text-muted-foreground shrink-0">{short[f.instance] ?? f.instance}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {f.wrongCampaigns.map((c) => (
                            <span key={c.id} className="text-[10px] rounded bg-amber-500/10 text-amber-500 px-1.5 py-0.5" title={`${c.name} (${c.status})`}>
                              {c.clientTag}: {c.name.split(":").slice(1).join(":").trim() || c.name}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
