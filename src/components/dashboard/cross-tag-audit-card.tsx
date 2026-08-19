"use client";

// Dashboard widget: domains attached to campaigns that DON'T match their client
// tag (cross-client contamination). Run the audit (chunked Bison crawl), then
// drag-select / select-all the domains to strip out of the wrong-client
// campaigns. Removal is per-domain with error handling; a cleaned domain drops
// off. Collapsible. Admin-only.
//
// Spencer Aug-11: every batch call auto-retries transient failures (network
// drop, Vercel timeout, 5xx) with backoff, and whatever still fails is kept so
// "Retry failed" re-runs ONLY the failed slices — never the whole audit or
// removal from scratch.
import { useState, useEffect, useRef, useCallback } from "react";
import { ChevronDown, ChevronRight, RefreshCw, Loader2, AlertTriangle, Trash2, RotateCcw, Archive } from "lucide-react";

interface WrongCampaign { id: number; name: string; status: string; clientTag: string; instance: string }
interface FlaggedDomain { instance: string; domain: string; clientTag: string; wrongCampaigns: WrongCampaign[] }
interface Job { instance: string; id: number; name: string; status: string; domains: string[] }

import { INSTANCE_SHORT_LABELS } from "@/lib/bison-instances";

const short: Record<string, string> = INSTANCE_SHORT_LABELS;
const RUN_BATCH = 50;
// Campaign jobs per removal request. The FE dedups the whole selection down
// to unique campaigns first (the same ~200 campaigns repeat across thousands
// of flagged domains) — each request processes a slice of those, so progress
// ticks every batch and each campaign is cleaned exactly once. Server-side
// each campaign is ~4-6 Bison calls (status → pause → remove rounds →
// resume). Kept small enough that a batch stays under Vercel's 300s limit
// even when Bison rate-limits and the server waits out full windows.
const CAMPAIGN_BATCH = 12;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// POST with auto-retry on transient failures: thrown fetch ("Failed to
// fetch" = network drop / function abort), 5xx, and non-JSON bodies (Vercel
// timeout pages). Permanent 4xx errors return immediately.
async function postJsonRetry(
  url: string,
  body: unknown,
  attempts = 3,
): Promise<{ ok: boolean; data: Record<string, unknown> | null; why: string }> {
  let why = "";
  for (let a = 0; a < attempts; a++) {
    try {
      const res = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const text = await res.text();
      let d: Record<string, unknown> | null = null;
      try { d = text ? JSON.parse(text) : null; } catch { /* non-JSON (timeout page) */ }
      if (res.ok && d && !d.error) return { ok: true, data: d, why: "" };
      why = !d
        ? (res.status >= 500 ? "server timed out or crashed" : `non-JSON response (HTTP ${res.status})`)
        : String(d.error || `HTTP ${res.status}`);
      const transient = res.status >= 500 || !d;
      if (!transient) return { ok: false, data: d, why };
    } catch (e) {
      why = e instanceof Error && e.message === "Failed to fetch"
        ? "network error / request aborted"
        : e instanceof Error ? e.message : "network error";
    }
    if (a < attempts - 1) await sleep(2000 * (a + 1));
  }
  return { ok: false, data: null, why: `${why} (retried ${attempts}×)` };
}

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
  // Campaigns Bison can never clean by removal (every sender belongs to the
  // flagged domains — it refuses to strip the last senders). Retry re-earns
  // the same 422 forever, so these are offered Archive instead.
  const [contaminated, setContaminated] = useState<Job[]>([]);
  const [archiving, setArchiving] = useState(false);
  // What failed last time, kept so Retry re-runs ONLY these (Spencer Aug-11).
  const [failedAuditBatches, setFailedAuditBatches] = useState<{ instance: string; domain: string }[][]>([]);
  const [failedJobs, setFailedJobs] = useState<Job[]>([]);

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

  // Full audit, or — when `retryBatches` is passed — ONLY the batches that
  // failed last time (no reset, existing findings stay).
  const runAudit = async (retryBatches?: { instance: string; domain: string }[][]) => {
    setRunning(true); setError(null); setFailures([]);
    if (!retryBatches) setSelected(new Set());
    const stillFailing: { instance: string; domain: string }[][] = [];
    try {
      let batches: { instance: string; domain: string }[][];
      if (retryBatches) {
        batches = retryBatches;
      } else {
        const res = await fetch("/api/replacement/cross-tag-audit?list=domains", { cache: "no-store" });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || "Failed to load domains");
        const domains: { instance: string; domain: string }[] = d.domains || [];
        batches = [];
        for (let i = 0; i < domains.length; i += RUN_BATCH) batches.push(domains.slice(i, i + RUN_BATCH));
      }
      const total = batches.reduce((n, b) => n + b.length, 0);
      let found = 0, done = 0;
      const whys = new Set<string>();
      setRunProgress({ done: 0, total, found: 0 });
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const r = await postJsonRetry("/api/replacement/cross-tag-audit", { domains: batch, reset: !retryBatches && i === 0 });
        if (!r.ok) { stillFailing.push(batch); whys.add(r.why); }
        else found += Number(r.data?.flaggedCount) || 0;
        done += batch.length;
        setRunProgress({ done, total, found });
        if (i % 5 === 0) await load(); // periodic refresh
      }
      await load();
      if (stillFailing.length > 0) {
        setError(`${stillFailing.length} audit batch${stillFailing.length === 1 ? "" : "es"} failed (${[...whys].join("; ")}) — results may be incomplete. Use "Retry failed" to re-run just those batches.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Audit failed");
    } finally {
      setFailedAuditBatches(stillFailing);
      // Never leave the card stuck.
      setRunning(false);
      setRunProgress(null);
    }
  };

  // Campaign-centric bulk removal core, used by both the fresh run and
  // "Retry failed". Server-side each campaign is paused, the candidate inbox
  // IDs are submitted to Bison's async deletion queue, then resumed.
  const executeJobs = async (jobList: Job[]) => {
    const failedJobKeys = new Set<string>();
    const failedJobList: Job[] = [];
    const contaminatedList: Job[] = [];
    const collectedFailures: { name: string; instance: string; error: string }[] = [];
    const chunkErrors: string[] = [];
    let removedTotal = 0;

    const startedAt = Date.now();
    for (let i = 0; i < jobList.length; i += CAMPAIGN_BATCH) {
      const batch = jobList.slice(i, i + CAMPAIGN_BATCH);
      const r = await postJsonRetry("/api/replacement/cross-tag-remove", { campaigns: batch });
      if (!r.ok) {
        chunkErrors.push(`Batch ${Math.floor(i / CAMPAIGN_BATCH) + 1}: ${r.why}`);
        for (const j of batch) { failedJobKeys.add(`${j.instance}:${j.id}`); failedJobList.push(j); }
      } else {
        const d = r.data as { removed?: number; results?: { instance: string; campaignId: number; name: string; ok: boolean; removed: number; error?: string }[] };
        removedTotal += d.removed || 0;
        for (const res of d.results || []) {
          if (!res.ok) {
            failedJobKeys.add(`${res.instance}:${res.campaignId}`);
            const j = batch.find((b) => b.instance === res.instance && b.id === res.campaignId);
            // "fully contaminated" is terminal — no retry can clear it, so it
            // goes to the archive list instead of the retry list.
            const isContaminated = (res.error || "").startsWith("fully contaminated");
            if (j) (isContaminated ? contaminatedList : failedJobList).push(j);
            collectedFailures.push({ name: res.name, instance: res.instance, error: res.error || "failed" });
          }
        }
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
    return { failedJobKeys, failedJobList, contaminatedList, collectedFailures, chunkErrors, removedTotal };
  };

  // Clear domains whose every wrong campaign succeeded; failures stay flagged
  // so the retry path re-runs exactly what's left.
  const clearCleaned = async (targets: FlaggedDomain[], failedJobKeys: Set<string>) => {
    const clearable = targets.filter((f) =>
      f.wrongCampaigns.every((c) => !failedJobKeys.has(`${f.instance}:${c.id}`)),
    );
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
    return clearable.length;
  };

  const removeSelected = async () => {
    const targets = flagged.filter((f) => selected.has(key(f)));
    if (targets.length === 0) return;
    setRemoving(true); setError(null); setFailures([]); setFailedJobs([]); setContaminated([]);

    // Group by unique (instance, campaign).
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
    setRemoveProgress({ done: 0, total: jobList.length, current: `${jobList.length} unique campaigns across ${targets.length} domains` });
    try {
      const out = await executeJobs(jobList);
      setRemoveProgress({ done: jobList.length, total: jobList.length, current: "clearing cleaned domains…" });
      await clearCleaned(targets, out.failedJobKeys);
      setFailedJobs(out.failedJobList);
      setContaminated(out.contaminatedList);
      if (out.chunkErrors.length) setError(out.chunkErrors.join(" · "));
      setFailures(out.collectedFailures);
    } finally {
      // Never leave the card stuck — buttons re-enable no matter what threw.
      setRemoving(false);
      setRemoveProgress(null);
    }
    setSelected(new Set());
    await load();
  };

  // Archive the fully-contaminated campaigns. Removal can never clear these
  // (Bison refuses to strip a campaign's last senders), so archiving is the
  // way out of the retry loop: it stops the campaign sending, and an archived
  // campaign is inert so the next audit won't flag it again.
  const archiveContaminated = async () => {
    if (contaminated.length === 0 || archiving) return;
    if (!window.confirm(
      `Archive ${contaminated.length} fully-contaminated campaign${contaminated.length === 1 ? "" : "s"}?\n\n` +
      `Every sender in ${contaminated.length === 1 ? "this campaign belongs" : "these campaigns belongs"} to the flagged domains, so Bison will not remove them — retrying keeps failing. Archiving stops the campaign sending.`,
    )) return;
    setArchiving(true); setError(null);
    try {
      const done = new Set<string>();
      for (let i = 0; i < contaminated.length; i += CAMPAIGN_BATCH) {
        const batch = contaminated.slice(i, i + CAMPAIGN_BATCH);
        const r = await postJsonRetry("/api/replacement/cross-tag-remove", {
          action: "archiveCampaigns",
          campaigns: batch.map((c) => ({ instance: c.instance, id: c.id, name: c.name })),
        });
        if (!r.ok) { setError(`Archive failed: ${r.why}`); break; }
        const d = r.data as { results?: { instance: string; campaignId: number; ok: boolean }[] };
        for (const res of d.results || []) if (res.ok) done.add(`${res.instance}:${res.campaignId}`);
      }
      // Domains whose every wrong campaign is now archived or cleaned are done.
      const targets = flagged.filter((f) => f.wrongCampaigns.some((c) => done.has(`${f.instance}:${c.id}`)));
      await clearCleaned(
        targets,
        new Set(
          flagged.flatMap((f) => f.wrongCampaigns
            .filter((c) => !done.has(`${f.instance}:${c.id}`))
            .map((c) => `${f.instance}:${c.id}`)),
        ),
      );
      setContaminated((prev) => prev.filter((c) => !done.has(`${c.instance}:${c.id}`)));
      setFailures((prev) => prev.filter((f) => !contaminated.some(
        (c) => done.has(`${c.instance}:${c.id}`) && c.name === f.name && c.instance === f.instance,
      )));
      await load();
    } finally {
      setArchiving(false);
    }
  };

  // Re-run ONLY the campaigns that failed last time — no re-audit, no
  // re-selection (Spencer Aug-11).
  const retryFailedJobs = async () => {
    if (failedJobs.length === 0) return;
    const jobs = [...failedJobs];
    setRemoving(true); setError(null); setFailures([]); setFailedJobs([]);
    setRemoveProgress({ done: 0, total: jobs.length, current: `retrying ${jobs.length} failed campaign(s)` });
    try {
      const out = await executeJobs(jobs);
      // clear rows whose every wrong campaign was covered by this retry and succeeded
      const retriedKeys = new Set(jobs.map((j) => `${j.instance}:${j.id}`));
      const targets = flagged.filter((f) => f.wrongCampaigns.every((c) => retriedKeys.has(`${f.instance}:${c.id}`)));
      await clearCleaned(targets, out.failedJobKeys);
      setFailedJobs(out.failedJobList);
      // Retry only covers `jobs`, so merge rather than replace — a contaminated
      // campaign found in an earlier pass must not fall off the archive list.
      setContaminated((prev) => {
        const retried = new Set(jobs.map((j) => `${j.instance}:${j.id}`));
        const kept = prev.filter((c) => !retried.has(`${c.instance}:${c.id}`));
        return [...kept, ...out.contaminatedList];
      });
      if (out.chunkErrors.length) setError(out.chunkErrors.join(" · "));
      setFailures(out.collectedFailures);
    } finally {
      setRemoving(false);
      setRemoveProgress(null);
    }
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
            <button onClick={() => runAudit()} disabled={busy} className="flex items-center gap-1.5 text-xs rounded-md border px-2.5 py-1.5 hover:bg-muted/50 disabled:opacity-50 shrink-0">
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
              {failedAuditBatches.length > 0 && !busy && (
                <button onClick={() => runAudit(failedAuditBatches)} className="flex items-center gap-1 shrink-0 rounded border border-destructive/40 px-2 py-0.5 hover:bg-destructive/10">
                  <RotateCcw className="h-3 w-3" /> Retry failed
                </button>
              )}
              {failedJobs.length > 0 && !busy && (
                <button onClick={retryFailedJobs} className="flex items-center gap-1 shrink-0 rounded border border-destructive/40 px-2 py-0.5 hover:bg-destructive/10">
                  <RotateCcw className="h-3 w-3" /> Retry {failedJobs.length} failed
                </button>
              )}
              <button onClick={() => setError(null)} className="shrink-0 opacity-60 hover:opacity-100" title="Dismiss">✕</button>
            </div>
          )}

          {/* Per-campaign failures from the last removal — the affected domains
              stay flagged in the list below; "Retry failed" re-runs only them. */}
          {failures.length > 0 && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5">
              <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-destructive font-medium">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {failures.length} campaign{failures.length === 1 ? "" : "s"} failed — their domains stay flagged
                {failedJobs.length > 0 && !busy && !archiving && (
                  <button onClick={retryFailedJobs} className="flex items-center gap-1 rounded border border-destructive/40 px-2 py-0.5 hover:bg-destructive/10">
                    <RotateCcw className="h-3 w-3" /> Retry {failedJobs.length} failed
                  </button>
                )}
                {/* Retry can never clear these — archiving is the only exit. */}
                {contaminated.length > 0 && !busy && (
                  <button
                    onClick={archiveContaminated}
                    disabled={archiving}
                    title="Every sender in these campaigns belongs to the flagged domains, so Bison refuses to remove them. Archiving stops them sending and clears the flag."
                    className="flex items-center gap-1 rounded border border-amber-500/50 text-amber-500 px-2 py-0.5 hover:bg-amber-500/10 disabled:opacity-50"
                  >
                    {archiving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Archive className="h-3 w-3" />}
                    Archive {contaminated.length} unfixable
                  </button>
                )}
                <button onClick={() => setFailures([])} className="ml-auto opacity-60 hover:opacity-100" title="Dismiss">✕</button>
              </div>
              {contaminated.length > 0 && (
                <div className="px-3 pb-1.5 text-[11px] text-amber-500/90">
                  {contaminated.length} of these {contaminated.length === 1 ? "is" : "are"} fully contaminated — every sender belongs to the flagged domains, so Bison refuses to remove them and retrying will keep failing. Archive them instead.
                </div>
              )}
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
