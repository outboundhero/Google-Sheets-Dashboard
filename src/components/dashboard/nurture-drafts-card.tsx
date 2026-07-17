"use client";

// Dashboard widget: nurture campaigns (name contains "[Nurture]") that are in
// DRAFT status with >= 100 leads and >= 10 attached sender inboxes, across all
// 4 Bison instances — i.e. ready to go live. Select (drag-select too) and
// Activate them via the resume endpoint. Admin-only, collapsible, lazy-loaded.
import { useState, useEffect, useRef, useCallback } from "react";
import { ChevronDown, ChevronRight, RefreshCw, Loader2, Rocket, Play, Check, AlertTriangle } from "lucide-react";
import { INSTANCE_SHORT_LABELS } from "@/lib/bison-instances";

interface NurtureDraft { instance: string; id: number; name: string; leads: number; senders: number }
interface LoadError { instance: string; error: string }
interface ActivateFailure { key: string; name: string; error: string }

const short: Record<string, string> = INSTANCE_SHORT_LABELS;

// Per-instance accent so each instance chip is distinct at a glance.
const instanceAccent: Record<string, string> = {
  outboundhero: "bg-violet-500/15 text-violet-500 border-violet-500/30",
  cleaningoutbound: "bg-sky-500/15 text-sky-500 border-sky-500/30",
  facilityreach: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30",
  outboundclean: "bg-amber-500/15 text-amber-500 border-amber-500/30",
};

// PATCH with auto-retry (3× with growing delays) on transport failures only.
async function patchWithRetry(url: string, body: unknown, attempts = 3): Promise<{ ok: boolean; status: number; error?: string }> {
  const WAITS = [2000, 5000, 10000];
  let lastStatus = 0;
  let lastError = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      lastStatus = res.status;
      const text = await res.text();
      let data: { error?: string } | null = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
      if (res.ok) return { ok: true, status: res.status };
      lastError = data?.error || text.slice(0, 150) || `HTTP ${res.status}`;
      const retryable = res.status === 429 || res.status >= 500 || data === null;
      if (retryable && attempt < attempts - 1) {
        await new Promise((r) => setTimeout(r, WAITS[Math.min(attempt, WAITS.length - 1)] + Math.floor(Math.random() * 300)));
        continue;
      }
      return { ok: false, status: res.status, error: lastError };
    } catch (e) {
      lastStatus = 0;
      lastError = e instanceof Error ? e.message : "network error";
      if (attempt < attempts - 1) { await new Promise((r) => setTimeout(r, WAITS[Math.min(attempt, WAITS.length - 1)])); continue; }
    }
  }
  return { ok: false, status: lastStatus, error: lastError || "failed" };
}

export function NurtureDraftsCard() {
  const [open, setOpen] = useState(false);
  const [campaigns, setCampaigns] = useState<NurtureDraft[]>([]);
  const [loadErrors, setLoadErrors] = useState<LoadError[]>([]);
  const [failures, setFailures] = useState<ActivateFailure[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set()); // key = instance:id
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dragging = useRef(false);
  const dragAdd = useRef(true);
  const loadedRef = useRef(false);

  const load = useCallback(async (fresh = false) => {
    try {
      const res = await fetch(`/api/campaigns/nurture-drafts${fresh ? "?fresh=1" : ""}`, { cache: "no-store" });
      const d = await res.json();
      if (res.ok) { setCampaigns(d.campaigns || []); setLoadErrors(d.errors || []); setError(null); }
      else setError(d.error || "Failed");
    } catch { setError("Failed to load"); }
  }, []);

  // Refresh forces a live re-crawl (bypasses the ~10-min server cache).
  const refresh = useCallback(async () => { setLoading(true); await load(true); setLoading(false); }, [load]);

  // Lazy load: the 4-instance live crawl only runs the first time the section
  // is expanded (and on manual Refresh) — never on every dashboard visit.
  const toggleOpen = useCallback(() => {
    setOpen((v) => {
      const next = !v;
      if (next && !loadedRef.current) { loadedRef.current = true; setLoading(true); load().finally(() => setLoading(false)); }
      return next;
    });
  }, [load]);

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

  const activate = async () => {
    const targets = campaigns.filter((c) => selected.has(`${c.instance}:${c.id}`));
    if (targets.length === 0) return;
    setWorking(true); setError(null); setFailures([]);
    setProgress({ done: 0, total: targets.length, current: targets[0]?.name ?? null });
    const failed: ActivateFailure[] = [];
    for (let i = 0; i < targets.length; i++) {
      const c = targets[i];
      const key = `${c.instance}:${c.id}`;
      setProgress({ done: i, total: targets.length, current: `${c.name} (${short[c.instance] ?? c.instance})` });
      const r = await patchWithRetry(`/api/campaigns/${c.id}/status?instance=${encodeURIComponent(c.instance)}`, { action: "resume" });
      if (!r.ok) failed.push({ key, name: c.name, error: `${r.status ? `HTTP ${r.status} — ` : ""}${r.error || "failed"}` });
      setProgress({ done: i + 1, total: targets.length, current: c.name });
    }
    setFailures(failed);
    setSelected(new Set(failed.map((f) => f.key))); // keep only failures selected → re-click Activate = retry
    setWorking(false); setProgress(null);
    await load(true); // fresh re-crawl so just-activated drafts drop off (bypass cache)
  };

  return (
    <div className="rounded-xl border bg-card">
      <button onClick={toggleOpen} className="w-full flex items-center gap-2 px-5 py-3 text-left">
        {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        <Rocket className="h-4 w-4 text-emerald-400 shrink-0" />
        <span className="text-sm font-medium">Nurture campaigns ready to activate</span>
        {campaigns.length > 0 && <span className="text-xs rounded-full bg-emerald-500/15 text-emerald-400 px-2 py-0.5">{campaigns.length}</span>}
        <span className="ml-auto text-[11px] text-muted-foreground">{open ? "collapse" : "expand"}</span>
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">
              Draft <b>[Nurture]</b> campaigns with ≥ 100 leads and ≥ 10 sender inboxes, across all 4 instances. Click to select (drag to multi-select), then Activate.
            </p>
            <button onClick={refresh} disabled={loading || working} className="flex items-center gap-1.5 text-xs rounded-md border px-2.5 py-1.5 hover:bg-muted/50 disabled:opacity-50 shrink-0">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
            </button>
          </div>

          {error && <div className="text-xs text-destructive">{error}</div>}
          {loadErrors.length > 0 && (
            <div className="flex items-start gap-1.5 text-[11px] text-amber-500">
              <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
              <span>Couldn&apos;t load {loadErrors.map((e) => short[e.instance] ?? e.instance).join(", ")} — list may be incomplete.</span>
            </div>
          )}

          {progress && (
            <div className="space-y-1">
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>Activating {progress.done}/{progress.total}</span>
                <span className="truncate max-w-[220px]">{progress.current}</span>
              </div>
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div className="h-full bg-emerald-500 transition-all" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2"><Loader2 className="h-4 w-4 animate-spin" /> Scanning all 4 instances…</div>
          ) : campaigns.length === 0 ? (
            <p className="text-sm text-emerald-600 dark:text-emerald-400">No nurture drafts ready to activate. ✓</p>
          ) : (
            <>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{selected.size} selected</span>
                <button
                  onClick={activate}
                  disabled={working || selected.size === 0}
                  className="flex items-center gap-1.5 rounded-md bg-emerald-600 text-white px-2.5 py-1.5 hover:bg-emerald-500 disabled:opacity-40"
                >
                  {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                  Activate {selected.size > 0 ? selected.size : ""} campaign{selected.size === 1 ? "" : "s"}
                </button>
              </div>

              <div className="rounded-lg border divide-y max-h-[440px] overflow-y-auto scrollbar-hide select-none">
                {campaigns.map((c) => {
                  const k = `${c.instance}:${c.id}`;
                  const sel = selected.has(k);
                  return (
                    <div
                      key={k}
                      onMouseDown={() => startDrag(k)}
                      onMouseEnter={() => { if (dragging.current) applyDrag(k); }}
                      title={sel ? "Will be activated" : "Click to select for activation"}
                      className={`group grid grid-cols-[92px_1fr_88px_96px_16px] items-center gap-3 px-3 py-2 cursor-pointer transition-colors ${sel ? "bg-emerald-500/10 ring-1 ring-inset ring-emerald-500/40" : "hover:bg-muted/50"}`}
                    >
                      <span className={`justify-self-start text-[10px] font-medium rounded border px-1.5 py-0.5 ${instanceAccent[c.instance] ?? "bg-muted text-muted-foreground border-border"}`}>
                        {short[c.instance] ?? c.instance}
                      </span>
                      <span className="text-xs font-medium truncate select-text cursor-text" title={c.name}>{c.name}</span>
                      <span className="text-[11px] text-foreground/80 justify-self-end whitespace-nowrap">
                        <span className="font-medium">{c.leads.toLocaleString()}</span> <span className="text-muted-foreground">leads</span>
                      </span>
                      <span className="text-[11px] text-foreground/80 justify-self-end whitespace-nowrap">
                        <span className="font-medium">{c.senders}</span> <span className="text-muted-foreground">inbox{c.senders === 1 ? "" : "es"}</span>
                      </span>
                      <span className={`justify-self-end transition-colors ${sel ? "text-emerald-500" : "text-muted-foreground/30 group-hover:text-muted-foreground"}`}>
                        {sel ? <Check className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {failures.length > 0 && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5">
              <div className="px-3 py-1.5 text-[11px] text-destructive font-medium">
                {failures.length} campaign{failures.length === 1 ? "" : "s"} failed to activate — still selected; hit Activate to retry
              </div>
              <div className="max-h-32 overflow-y-auto scrollbar-hide divide-y divide-destructive/10 border-t border-destructive/20">
                {failures.map((f) => (
                  <div key={f.key} className="flex items-center gap-2 px-3 py-1 text-[11px]">
                    <span className="font-medium truncate">{f.name}</span>
                    <span className="text-destructive/80 truncate ml-auto">{f.error}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
