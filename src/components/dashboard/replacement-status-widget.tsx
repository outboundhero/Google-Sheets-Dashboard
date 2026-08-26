"use client";

// Replacement status — MAIN-dashboard box (Spencer's Loom 2026-07-21: "right
// underneath the clients-without-meeting-leads box… default past 24 hours, a
// button for everything else, and a retry button"). Shows what automatic
// replacement did: tags added, campaigns attached, whitelist queued/sheet,
// errors — with one-click retry on failures. Reads the same audit log as the
// Replacement page. Self-hides when there's no activity in the window.
import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { RefreshCw, Repeat, RotateCcw, ArrowRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { replay } from "@/components/replacement/retry-card";
import type { RetryPayload } from "@/lib/replacement/execute-runner";
import { sourceOf, verbOf } from "@/lib/replacement/event-source";

const INSTANCE_SHORT: Record<string, string> = {
  outboundhero: "OH1", cleaningoutbound: "CO1", facilityreach: "FR2", outboundclean: "OC2",
};

interface Ev {
  id: number;
  instance: string | null;
  domain: string | null;
  clientTag: string | null;
  eventType: string;
  detail: string | null;
  createdAt: string;
  signals: { retry?: RetryPayload } | null;
}

type Win = "24h" | "all";

export function ReplacementStatusWidget() {
  const [win, setWin] = useState<Win>("24h");
  const [events, setEvents] = useState<Ev[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState<Record<number, string>>({});

  const load = useCallback(async (w: Win) => {
    setLoading(true);
    try {
      const qs = w === "24h" ? "limit=200&days=1" : "limit=300&days=7";
      const res = await fetch(`/api/replacement/events?${qs}`, { cache: "no-store" });
      const d = await res.json();
      if (res.ok) setEvents(d.events || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);
  useEffect(() => {
    const id = setTimeout(() => load("24h"), 0);
    return () => clearTimeout(id);
  }, [load]);
  // Live: Spencer + Nick 2026-08-26 want to "see the bot working" without
  // asking — refresh every minute while the dashboard is open.
  useEffect(() => {
    const id = setInterval(() => load(win), 60_000);
    return () => clearInterval(id);
  }, [load, win]);

  const pick = (w: Win) => { setWin(w); load(w); };

  const retry = async (ev: Ev) => {
    const p = ev.signals?.retry;
    if (!p) return;
    setRetrying((s) => ({ ...s, [ev.id]: "running" }));
    const r = await replay(p);
    setRetrying((s) => ({ ...s, [ev.id]: r.ok ? `✓ ${r.note}` : `still failing` }));
    fetch("/api/replacement/record", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [{ instance: p.instance, clientTag: p.clientTag, eventType: r.ok ? "attached" : "error", detail: `dashboard retry ${p.step}: ${r.note}`, signals: r.ok ? null : { kind: `${p.step}_retry_failed`, retry: p } }] }),
    }).catch(() => {});
  };

  // No self-hiding any more: an empty box that says "quiet" is itself the
  // information Spencer asked for (is the bot working or not).
  const counts = { tagged: 0, attached: 0, whitelist: 0, removed: 0, errors: 0 };
  const bySource = new Map<string, number>();
  for (const e of events || []) {
    if (e.eventType === "tagged") counts.tagged++;
    else if (e.eventType === "attached") counts.attached++;
    else if (e.eventType === "removed") counts.removed++;
    else if (e.eventType === "error") counts.errors++;
    if (e.detail?.toLowerCase().includes("whitelist")) counts.whitelist++;
    const s = sourceOf(e.detail, e.eventType);
    bySource.set(s, (bySource.get(s) ?? 0) + 1);
  }

  return (
    <Card>
      <CardContent className="p-5 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium">
              <Repeat className="h-4 w-4" />
              System activity
              <span className="inline-flex items-center gap-1 text-[10px] font-normal text-emerald-500"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" /> live</span>
              {counts.errors > 0 && <Badge variant="outline" className="border-destructive/40 text-destructive">{counts.errors} need retry</Badge>}
            </div>
            <div className="text-[11px] text-muted-foreground">
              Every automatic action and why — replacement, true-up fill/trim, moves, duplicate cleanup, redirect conform, deletions. Refreshes every minute.
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant={win === "24h" ? "default" : "outline"} onClick={() => pick("24h")} className="h-7 text-xs">Past 24h</Button>
            <Button size="sm" variant={win === "all" ? "default" : "outline"} onClick={() => pick("all")} className="h-7 text-xs">Everything else</Button>
            <Button size="sm" variant="ghost" onClick={() => load(win)} disabled={loading} className="h-7 px-2">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            </Button>
            <Link href="/replacement" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
              Replacement <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        </div>

        {events && events.length > 0 && (
          <>
            <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
              <span>Tagged <b className="text-foreground">{counts.tagged}</b></span>
              <span>Campaigns attached <b className="text-foreground">{counts.attached}</b></span>
              <span>Whitelist steps <b className="text-foreground">{counts.whitelist}</b></span>
              <span>Removed <b className="text-foreground">{counts.removed}</b></span>
              <span>Errors <b className={counts.errors ? "text-destructive" : "text-foreground"}>{counts.errors}</b></span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {[...bySource.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => (
                <span key={s} className="text-[10px] px-1.5 py-0.5 rounded-full border text-muted-foreground">{s} <b className="text-foreground">{n}</b></span>
              ))}
            </div>
            <div className="rounded-lg border divide-y max-h-[260px] overflow-y-auto">
              {(events || []).slice(0, 60).map((e) => (
                <div key={e.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                  <span className="text-muted-foreground tabular-nums w-[92px] shrink-0">
                    {new Date(e.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  </span>
                  <span className="font-medium w-[70px] shrink-0 truncate">{e.clientTag ?? "—"}</span>
                  <span className="text-muted-foreground w-[38px] shrink-0">{e.instance ? (INSTANCE_SHORT[e.instance] ?? e.instance) : ""}</span>
                  <span className={`w-[120px] shrink-0 ${e.eventType === "error" ? "text-destructive" : ["tagged", "attached", "redirect_set"].includes(e.eventType) ? "text-emerald-500" : ["removed", "cancel_queued"].includes(e.eventType) ? "text-amber-500" : "text-muted-foreground"}`}>{verbOf(e.eventType)}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full border text-muted-foreground shrink-0">{sourceOf(e.detail, e.eventType)}</span>
                  <span className="truncate flex-1 text-muted-foreground" title={`${e.domain ?? ""} ${e.detail ?? ""}`}>{e.domain ? <span className="text-foreground/80 mr-1">{e.domain}</span> : null}{e.detail}</span>
                  {e.eventType === "error" && e.signals?.retry && (
                    retrying[e.id] && retrying[e.id] !== "running" ? (
                      <span className={retrying[e.id].startsWith("✓") ? "text-emerald-500 shrink-0" : "text-destructive shrink-0"}>{retrying[e.id]}</span>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => retry(e)} disabled={retrying[e.id] === "running"} className="h-6 px-2 text-[11px] gap-1 shrink-0">
                        <RotateCcw className={`h-3 w-3 ${retrying[e.id] === "running" ? "animate-spin" : ""}`} />
                        {retrying[e.id] === "running" ? "…" : "Retry"}
                      </Button>
                    )
                  )}
                </div>
              ))}
            </div>
          </>
        )}
        {events && events.length === 0 && (
          <p className="text-xs text-muted-foreground italic">
            {win === "24h" ? "Quiet — no automatic actions in the last 24 hours." : "No automatic actions in the last 7 days."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
