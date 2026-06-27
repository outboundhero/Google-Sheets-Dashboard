"use client";

// Small dashboard widget: refresh the Client Tracker sheet and check client-tag
// alignment — clients that have domains but are missing from the tracker
// (untracked), and tracker entries with no domains (orphan). The redirect-URL
// half of the audit lives in the RedirectIssuesCard; this is the tag half.
// Collapsible. Admin-only.
import { useState, useEffect, useCallback } from "react";
import { ChevronDown, ChevronRight, RefreshCw, AlertTriangle, CheckCircle2 } from "lucide-react";

interface Alignment { trackerCount: number; assignedCount: number; untracked: string[]; orphan: string[]; checkedAt?: string }

export function TagAlignmentCard() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Alignment | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/replacement/tag-alignment", { cache: "no-store" });
      const d = await res.json();
      if (res.ok) setData(d); else setError(d.error || "Failed");
    } catch { setError("Failed to load"); }
    setLoading(false);
  }, []);

  useEffect(() => {
    let alive = true;
    fetch("/api/replacement/tag-alignment", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (alive && !d.error) setData(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const issues = data ? data.untracked.length + data.orphan.length : 0;

  return (
    <div className="rounded-xl border bg-card">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-2 px-5 py-3 text-left">
        {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        <RefreshCw className="h-4 w-4 text-sky-400 shrink-0" />
        <span className="text-sm font-medium">Client Tracker — tag alignment</span>
        {issues > 0 && <span className="text-xs rounded-full bg-amber-500/15 text-amber-500 px-2 py-0.5">{issues}</span>}
        <span className="ml-auto text-[11px] text-muted-foreground">{open ? "collapse" : "expand"}</span>
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">
              Re-reads the Client Tracker sheet and checks which client tags are misaligned between the sheet and the system.
            </p>
            <button onClick={refresh} disabled={loading} className="flex items-center gap-1.5 text-xs rounded-md border px-2.5 py-1.5 hover:bg-muted/50 disabled:opacity-50 shrink-0">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> {loading ? "Refreshing…" : "Refresh sheet"}
            </button>
          </div>

          {error && <div className="text-xs text-destructive">{error}</div>}

          {data && (
            <>
              <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                <span>Tracker tags <b className="text-foreground">{data.trackerCount}</b></span>
                <span>Assigned in system <b className="text-foreground">{data.assignedCount}</b></span>
              </div>

              {issues === 0 ? (
                <p className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="h-4 w-4" /> Client tags aligned.</p>
              ) : (
                <div className="grid sm:grid-cols-2 gap-3">
                  <div>
                    <div className="flex items-center gap-1.5 text-[11px] font-medium text-amber-500 mb-1">
                      <AlertTriangle className="h-3 w-3" /> Untracked — in system, not in sheet ({data.untracked.length})
                    </div>
                    {data.untracked.length === 0 ? <p className="text-[11px] text-muted-foreground">none</p> : (
                      <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto">
                        {data.untracked.map((t) => <span key={t} className="text-[10px] rounded bg-amber-500/10 text-amber-500 px-1.5 py-0.5">{t}</span>)}
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground mb-1">
                      <AlertTriangle className="h-3 w-3" /> Orphan — in sheet, no domains ({data.orphan.length})
                    </div>
                    {data.orphan.length === 0 ? <p className="text-[11px] text-muted-foreground">none</p> : (
                      <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto">
                        {data.orphan.map((t) => <span key={t} className="text-[10px] rounded bg-muted text-muted-foreground px-1.5 py-0.5">{t}</span>)}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {data.checkedAt && <p className="text-[10px] text-muted-foreground">Last checked {new Date(data.checkedAt).toLocaleString()}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
