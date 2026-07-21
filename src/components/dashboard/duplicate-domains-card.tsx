"use client";

// Dashboard widget: domains that exist in MORE THAN ONE of the 4 instances
// (overlapping infra). Pick which instance(s) to strip a domain from — it
// removes the domain's senders from that instance's campaigns now (error
// handling), then schedules the domain/senders for deletion from that instance
// after a 4-day grace (a cron fires the actual delete). Drag-select chips.
// Collapsible. Admin-only.
import { useState, useEffect, useRef, useCallback } from "react";
import { ChevronDown, ChevronRight, RefreshCw, Loader2, Copy, Trash2, Clock, Check } from "lucide-react";

interface DupInstance { instance: string; inboxes: number; tags: string[]; createdAt: string | null }
interface DuplicateDomain { domain: string; instances: DupInstance[] }
interface PendingDeletion { instance: string; domain: string; scheduledAt: string; status: string }

import { INSTANCE_SHORT_LABELS } from "@/lib/bison-instances";

const short: Record<string, string> = INSTANCE_SHORT_LABELS;

// Per-instance accent (badge) so each instance card is visually distinct at a glance.
const instanceAccent: Record<string, string> = {
  outboundhero: "bg-violet-500/15 text-violet-500 border-violet-500/30",
  cleaningoutbound: "bg-sky-500/15 text-sky-500 border-sky-500/30",
  facilityreach: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30",
  outboundclean: "bg-amber-500/15 text-amber-500 border-amber-500/30",
};

const TAG_CAP = 5;

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function DuplicateDomainsCard() {
  const [open, setOpen] = useState(false);
  const [dups, setDups] = useState<DuplicateDomain[]>([]);
  const [pending, setPending] = useState<PendingDeletion[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set()); // key = instance:domain
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [firing, setFiring] = useState(false);
  const [fireMsg, setFireMsg] = useState<string | null>(null);
  const [fireStuck, setFireStuck] = useState<{ domain: string; instance: string; remainingInBison: number; failed: number }[]>([]);

  const dragging = useRef(false);
  const dragAdd = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/replacement/duplicate-domains", { cache: "no-store" });
      const d = await res.json();
      if (res.ok) { setDups(d.duplicates || []); setPending(d.pending || []); setError(null); }
      else setError(d.error || "Failed");
    } catch { setError("Failed to load"); }
  }, []);
  const refresh = useCallback(async () => { setLoading(true); await load(); setLoading(false); }, [load]);
  useEffect(() => {
    let alive = true;
    fetch("/api/replacement/duplicate-domains", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (alive && !d.error) { setDups(d.duplicates || []); setPending(d.pending || []); } })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

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

  const cleanSelected = async () => {
    const targets = [...selected].map((k) => { const [instance, ...d] = k.split(":"); return { instance, domain: d.join(":") }; });
    if (targets.length === 0) return;
    setWorking(true); setError(null);
    setProgress({ done: 0, total: targets.length, current: targets[0]?.domain ?? null });
    const scheduled: { instance: string; domain: string }[] = [];
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      setProgress({ done: i, total: targets.length, current: `${t.domain} (${short[t.instance] ?? t.instance})` });
      try {
        // 1. discover this domain's campaigns (all clients), keep only the target instance's
        const disc = await fetch("/api/deliverability/remove-from-campaigns", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domains: [t.domain], discover: true, allClients: true }),
        }).then((r) => r.json());
        const campaigns = (disc.campaigns || []).filter((c: { instance: string }) => c.instance === t.instance);
        // 2. remove from those campaigns
        let ok = true;
        if (campaigns.length > 0) {
          const rem = await fetch("/api/deliverability/remove-from-campaigns", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ domains: [t.domain], campaigns }),
          }).then((r) => r.json());
          ok = !rem.error && !(rem.details || []).some((x: { error?: string }) => x.error);
        }
        // 3. schedule deletion only if the campaign removal was clean
        if (ok) scheduled.push(t);
      } catch { /* keep going */ }
      setProgress({ done: i + 1, total: targets.length, current: t.domain });
    }
    if (scheduled.length > 0) {
      await fetch("/api/replacement/duplicate-domains", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targets: scheduled }),
      });
    }
    setWorking(false); setProgress(null); setSelected(new Set());
    await load();
  };

  // Fire due scheduled deletions on demand (same executor as the cron), looping
  // small batches until the backlog is drained — or until a batch makes no
  // progress, which means some domains are genuinely stuck (surfaced below).
  const runDeletionsNow = async () => {
    setFiring(true); setFireMsg("Starting…"); setFireStuck([]);
    let totalFired = 0;
    try {
      for (let i = 0; i < 60; i++) {
        const res = await fetch("/api/replacement/duplicate-domains/run", { method: "POST" });
        const d = await res.json();
        if (!res.ok) { setFireMsg(d.error || `HTTP ${res.status}`); break; }
        totalFired += d.completed || 0;
        const stuck = (d.results || [])
          .filter((r: { done: boolean }) => !r.done)
          .map((r: { domain: string; instance: string; remainingInBison: number; failed: number }) => ({ domain: r.domain, instance: r.instance, remainingInBison: r.remainingInBison, failed: r.failed }));
        setFireStuck(stuck);
        setFireMsg(`Fired ${totalFired} · ${d.dueRemaining ?? 0} still due`);
        await load();
        if ((d.due ?? 0) === 0) { setFireMsg(`Done — fired ${totalFired}, nothing left due.`); break; }
        // No progress this batch → the remaining ones are stuck; stop looping.
        if ((d.completed ?? 0) === 0) { setFireMsg(`Fired ${totalFired}. ${d.dueRemaining ?? 0} stuck — see below.`); break; }
      }
    } catch (e) {
      setFireMsg(e instanceof Error ? e.message : "Run failed");
    } finally {
      setFiring(false);
    }
  };

  const cancelPending = async (p: PendingDeletion) => {
    await fetch("/api/replacement/duplicate-domains", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel", instance: p.instance, domain: p.domain }),
    });
    await load();
  };

  return (
    <div className="rounded-xl border bg-card">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-2 px-5 py-3 text-left">
        {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        <Copy className="h-4 w-4 text-violet-400 shrink-0" />
        <span className="text-sm font-medium">Duplicate domains across instances</span>
        {dups.length > 0 && <span className="text-xs rounded-full bg-violet-500/15 text-violet-400 px-2 py-0.5">{dups.length}</span>}
        {pending.length > 0 && <span className="text-[11px] text-amber-500">· {pending.length} pending delete</span>}
        <span className="ml-auto text-[11px] text-muted-foreground">{open ? "collapse" : "expand"}</span>
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">
              Same domain in 2+ instances — each card shows that instance&apos;s inboxes, tags, and created date. Click an instance to <b>remove</b> the domain from it (drag to multi-select) — leaves it in the others. Removes its senders from that instance&apos;s campaigns, then schedules deletion after 4 days.
            </p>
            <button onClick={refresh} disabled={loading || working} className="flex items-center gap-1.5 text-xs rounded-md border px-2.5 py-1.5 hover:bg-muted/50 disabled:opacity-50 shrink-0">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
            </button>
          </div>

          {error && <div className="text-xs text-destructive">{error}</div>}

          {progress && (
            <div className="space-y-1">
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>Cleaning {progress.done}/{progress.total}</span>
                <span className="truncate max-w-[220px]">{progress.current}</span>
              </div>
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div className="h-full bg-violet-500 transition-all" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
              </div>
            </div>
          )}

          {dups.length === 0 && !loading ? (
            <p className="text-sm text-emerald-600 dark:text-emerald-400">No duplicate domains across instances. ✓</p>
          ) : dups.length > 0 && (
            <>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{selected.size} selected</span>
                <button
                  onClick={cleanSelected}
                  disabled={working || selected.size === 0}
                  className="flex items-center gap-1.5 rounded-md bg-destructive/90 text-destructive-foreground px-2.5 py-1.5 hover:bg-destructive disabled:opacity-40"
                >
                  {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  Remove + schedule delete
                </button>
              </div>

              <div className="rounded-lg border divide-y max-h-[440px] overflow-y-auto select-none">
                {dups.map((d) => (
                  <div key={d.domain} className="px-3 py-2">
                    <div className="flex items-baseline gap-2 mb-1">
                      <span className="text-xs font-semibold truncate select-text cursor-text">{d.domain}</span>
                      <span className="text-[10px] text-muted-foreground shrink-0">· {d.instances.length} instances</span>
                    </div>
                    <div className="space-y-0.5">
                      {d.instances.map((inst) => {
                        const k = `${inst.instance}:${d.domain}`;
                        const sel = selected.has(k);
                        const shownTags = inst.tags.slice(0, TAG_CAP);
                        const extra = inst.tags.length - shownTags.length;
                        return (
                          <div
                            key={inst.instance}
                            onMouseDown={() => startDrag(k)}
                            onMouseEnter={() => { if (dragging.current) applyDrag(k); }}
                            title={sel ? "Will remove from this instance" : "Click to remove the domain from this instance"}
                            className={`group grid grid-cols-[92px_78px_150px_1fr_16px] items-center gap-3 rounded-md px-2 py-1.5 cursor-pointer transition-colors ${sel ? "bg-destructive/10 ring-1 ring-inset ring-destructive/40" : "hover:bg-muted/50"}`}
                          >
                            <span className={`justify-self-start text-[10px] font-medium rounded border px-1.5 py-0.5 ${instanceAccent[inst.instance] ?? "bg-muted text-muted-foreground border-border"}`}>
                              {short[inst.instance] ?? inst.instance}
                            </span>
                            <span className="text-[11px] text-foreground/80">
                              <span className="font-medium">{inst.inboxes}</span> <span className="text-muted-foreground">inbox{inst.inboxes === 1 ? "" : "es"}</span>
                            </span>
                            <span className="text-[10px] text-muted-foreground whitespace-nowrap">created {fmtDate(inst.createdAt)}</span>
                            <div className="flex items-center gap-1 overflow-hidden">
                              {inst.tags.length === 0 ? (
                                <span className="text-[10px] text-muted-foreground/50 italic">no tags</span>
                              ) : (
                                <>
                                  {shownTags.map((t) => (
                                    <span key={t} className="shrink-0 text-[9px] rounded bg-muted px-1.5 py-0.5 text-muted-foreground max-w-[110px] truncate" title={t}>{t}</span>
                                  ))}
                                  {extra > 0 && (
                                    <span className="shrink-0 text-[9px] rounded bg-muted px-1.5 py-0.5 text-muted-foreground" title={inst.tags.slice(TAG_CAP).join(", ")}>+{extra}</span>
                                  )}
                                </>
                              )}
                            </div>
                            <span className={`justify-self-end transition-colors ${sel ? "text-destructive" : "text-muted-foreground/30 group-hover:text-muted-foreground"}`}>
                              {sel ? <Check className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {pending.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-[11px] text-amber-500"><Clock className="h-3 w-3" /> Pending deletion (after 4-day grace)</div>
                <button
                  onClick={runDeletionsNow}
                  disabled={firing}
                  title="Fire all deletions whose 4-day grace has already passed, now"
                  className="flex items-center gap-1.5 text-[11px] rounded-md border px-2 py-1 hover:bg-muted/50 disabled:opacity-50"
                >
                  {firing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                  Run due deletions now
                </button>
              </div>
              {fireMsg && <div className="text-[11px] text-muted-foreground">{fireMsg}</div>}
              {fireStuck.length > 0 && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 space-y-0.5 max-h-32 overflow-y-auto">
                  <div className="text-[10px] font-medium text-destructive">Stuck ({fireStuck.length}) — Bison still reports senders / delete failing:</div>
                  {fireStuck.map((s) => (
                    <div key={`${s.instance}:${s.domain}`} className="text-[10px] text-muted-foreground">
                      {s.domain} <span className="opacity-70">{short[s.instance] ?? s.instance}</span> · {s.remainingInBison < 0 ? "errored" : `${s.remainingInBison} left in Bison`}{s.failed > 0 ? `, ${s.failed} failed` : ""}
                    </div>
                  ))}
                </div>
              )}
              <div className="rounded-lg border border-amber-500/30 divide-y divide-amber-500/10 max-h-40 overflow-y-auto">
                {pending.map((p) => (
                  <div key={`${p.instance}:${p.domain}`} className="flex items-center justify-between px-3 py-1.5 text-xs">
                    <span className="truncate">{p.domain} <span className="text-muted-foreground">{short[p.instance] ?? p.instance}</span></span>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[10px] text-muted-foreground">fires {new Date(p.scheduledAt).toLocaleDateString()}</span>
                      <button onClick={() => cancelPending(p)} className="text-[10px] text-primary hover:underline">cancel</button>
                    </div>
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
