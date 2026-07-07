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
const RUN_BATCH = 40;
// Domains per removal request. The endpoint is campaign-centric (unique
// campaigns dominate the wall clock, and they repeat massively across
// domains), so large chunks are cheap — this mostly bounds payload size and
// keeps each request comfortably under the 300s route budget.
const REMOVE_CHUNK = 800;

export function CrossTagAuditCard() {
  const [open, setOpen] = useState(false);
  const [flagged, setFlagged] = useState<FlaggedDomain[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [runProgress, setRunProgress] = useState<{ done: number; total: number; found: number } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeProgress, setRemoveProgress] = useState<{ done: number; total: number; current: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    setRunning(true); setError(null); setSelected(new Set());
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
          const rd = await r.json();
          found += rd.flaggedCount || 0;
        } catch { /* skip batch */ }
        setRunProgress({ done: Math.min(i + RUN_BATCH, domains.length), total: domains.length, found });
        if (i % (RUN_BATCH * 5) === 0) await load(); // periodic refresh
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Audit failed");
    }
    setRunning(false); setRunProgress(null);
  };

  // Campaign-centric bulk removal. The old flow looped domains one at a time
  // and re-fetched each campaign's sender list per domain — with the same
  // ~200 campaigns shared across 2,000+ domains that took hours. The new
  // endpoint dedups by campaign, pauses/removes/resumes each unique campaign
  // ONCE for all its domains, and bulk-clears cleaned rows.
  const removeSelected = async () => {
    const targets = flagged.filter((f) => selected.has(key(f)));
    if (targets.length === 0) return;
    setRemoving(true); setError(null);
    let cleared = 0;
    let failedCampaigns = 0;
    setRemoveProgress({ done: 0, total: targets.length, current: "grouping campaigns…" });
    for (let i = 0; i < targets.length; i += REMOVE_CHUNK) {
      const chunk = targets.slice(i, i + REMOVE_CHUNK);
      setRemoveProgress({
        done: i,
        total: targets.length,
        current: `cleaning chunk ${Math.floor(i / REMOVE_CHUNK) + 1}/${Math.ceil(targets.length / REMOVE_CHUNK)}…`,
      });
      try {
        const res = await fetch("/api/replacement/cross-tag-remove", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: chunk.map((f) => ({
              instance: f.instance,
              domain: f.domain,
              campaigns: f.wrongCampaigns.map((c) => ({ id: c.id, name: c.name, status: c.status })),
            })),
          }),
        });
        const d = await res.json();
        if (!res.ok || d.error) {
          setError(d.error || `Chunk failed (HTTP ${res.status}) — failed domains stay flagged for retry`);
        } else {
          cleared += d.domainsCleared || 0;
          failedCampaigns += d.campaignsFailed || 0;
        }
      } catch {
        setError("Network error on a chunk — affected domains stay flagged for retry");
      }
      setRemoveProgress({
        done: Math.min(i + REMOVE_CHUNK, targets.length),
        total: targets.length,
        current: `${cleared} domains cleared${failedCampaigns ? ` · ${failedCampaigns} campaigns failed` : ""}`,
      });
    }
    setRemoving(false); setRemoveProgress(null);
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

          {error && <div className="flex items-center gap-2 text-xs text-destructive"><AlertTriangle className="h-3.5 w-3.5" />{error}</div>}

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
                    <span>Removing {removeProgress.done}/{removeProgress.total}</span>
                    <span className="truncate max-w-[200px]">{removeProgress.current}</span>
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
