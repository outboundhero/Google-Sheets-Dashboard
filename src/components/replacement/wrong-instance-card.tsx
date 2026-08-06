"use client";

// Wrong-instance fix (Nick #3, 2026-08-05). Flags clients whose domains live on
// a Bison instance in the WRONG group vs their allocation, and gives each a
// per-client "Run" button that MOVES those domains to the correct instance
// (same tier, allocated group) via the existing Inboxing move flow — confirm
// first, nothing silent-automatic. The move uploads to the target and leaves
// the source copy in place; remove it afterward via the Delete Domains flow.
// Reads /api/replacement/wrong-instance; the Run action drives
// /api/deliverability/move-domains (submit → poll). Additive — nothing else on
// the tab changes.
import { useState, useEffect, useCallback } from "react";
import { RefreshCw, ArrowRightLeft, AlertTriangle, Play, Loader2, CheckCircle2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface MoveGroup {
  sourceInstance: string; sourceLabel: string;
  targetInstance: string; targetLabel: string;
  tier: string; platformConnectionId: string;
  domains: string[]; inboxingDomains: string[]; otherDomains: string[]; inboxCount: number;
}
interface FlaggedClient {
  clientTag: string; allocatedGroup: number;
  misplacedDomains: number; inboxingDomains: number; inboxCount: number;
  groups: MoveGroup[];
}
interface Resp {
  checkedAt: string; clientsFlagged: number; domainsMisplaced: number;
  flagged: FlaggedClient[]; error?: string;
}

interface Prog { stage: string; done: number; uploading: number; skipped: number; failed: number; total: number; note?: string }
type MoveRow = { domain: string; status: string; sourceInstance?: string; expected?: number; landed?: number; error?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postMove(body: unknown): Promise<{ results?: MoveRow[]; error?: string } | null> {
  try {
    const res = await fetch("/api/deliverability/move-domains", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { results?: MoveRow[]; error?: string } | null;
    if (!res.ok || !json || json.error) return json?.error ? { error: json.error } : null;
    return json;
  } catch { return null; }
}

export function WrongInstanceCard() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [runningTag, setRunningTag] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, Prog>>({});

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const res = await fetch("/api/replacement/wrong-instance", { cache: "no-store" });
      const json = (await res.json()) as Resp;
      if (!res.ok || json.error) throw new Error(json.error || "Failed");
      setData(json);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { const id = setTimeout(load, 0); return () => clearTimeout(id); }, [load]);

  // Move ONE client's misplaced domains to the correct instance, per group,
  // SUBMIT → POLL. Only Inboxing domains move (the route skips the rest); the
  // source copy stays until removed via the Delete Domains flow.
  const runClient = useCallback(async (c: FlaggedClient) => {
    setConfirming(null);
    setRunningTag(c.clientTag);
    const agg: Prog = { stage: "submitting", done: 0, uploading: 0, skipped: 0, failed: 0, total: c.inboxingDomains, note: undefined };
    const paint = (patch?: Partial<Prog>) => { Object.assign(agg, patch); setProgress((p) => ({ ...p, [c.clientTag]: { ...agg } })); };
    paint();
    try {
      for (const g of c.groups) {
        if (g.inboxingDomains.length === 0) continue;   // nothing this hop can auto-move
        paint({ stage: `moving ${g.sourceLabel} → ${g.targetLabel}` });
        let inflight: { domain: string; sourceInstance: string; expected: number; landed?: number }[] = [];
        const sr = await postMove({ mode: "submit", dryRun: false, domains: g.inboxingDomains, targetInstance: g.targetInstance, platformConnectionId: g.platformConnectionId });
        if (!sr || !sr.results) { agg.failed += g.inboxingDomains.length; paint(); continue; }
        for (const r of sr.results) {
          if (r.status === "uploading") { agg.uploading++; inflight.push({ domain: r.domain, sourceInstance: r.sourceInstance || g.sourceInstance, expected: r.expected ?? 1 }); }
          else if (r.status === "skipped") agg.skipped++;
          else if (r.status === "done") agg.done++;
          else agg.failed++;
        }
        paint();

        // POLL — finalize each domain as its senders land on the target.
        const deadline = Date.now() + 10 * 60 * 1000;
        while (inflight.length > 0 && Date.now() < deadline) {
          await sleep(12_000);
          const pr = await postMove({ mode: "poll", dryRun: false, inflight, targetInstance: g.targetInstance });
          if (pr && pr.results) {
            const still: typeof inflight = [];
            for (const r of pr.results) {
              if (r.status === "done") { agg.done++; agg.uploading = Math.max(0, agg.uploading - 1); }
              else { const f = inflight.find((x) => x.domain === r.domain); if (f) { if (typeof r.landed === "number") f.landed = r.landed; still.push(f); } }
            }
            inflight = still;
          }
          paint({ note: inflight.length ? `${inflight.length} still uploading…` : undefined });
        }
      }
      paint({ stage: "done", note: undefined });
    } finally {
      setRunningTag(null);
      load();   // re-detect — moved domains now report on the target instance too
    }
  }, [load]);

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium">
              <ArrowRightLeft className="h-4 w-4" />
              Wrong instance — move to the right one
              {data && data.clientsFlagged > 0 && (
                <Badge variant="outline" className="border-amber-500/40 text-amber-500">{data.clientsFlagged} flagged</Badge>
              )}
            </div>
            <div className="text-[11px] text-muted-foreground">
              Clients with domains on a Bison instance in the wrong group vs their allocation. Run moves them to the
              matching-tier instance in the allocated group via Inboxing (confirm first). The source copy stays —
              remove it afterward on the Deliverability page.
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={load} disabled={loading} className="gap-2">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            {loading ? "Scanning…" : "Scan"}
          </Button>
        </div>

        {err && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{err}</div>}

        {data && (
          data.flagged.length === 0 ? (
            <div className="flex items-center gap-2 text-xs text-emerald-500">
              <CheckCircle2 className="h-4 w-4" /> Every allocated client&apos;s domains are on the correct instance.
            </div>
          ) : (
            <div className="rounded-lg border divide-y max-h-[460px] overflow-y-auto">
              {data.flagged.map((c) => {
                const prog = progress[c.clientTag];
                const isRunning = runningTag === c.clientTag;
                const isConfirming = confirming === c.clientTag;
                const canRun = c.inboxingDomains > 0;
                return (
                  <div key={c.clientTag} className="px-3 py-2.5 text-xs space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <span className="font-medium">{c.clientTag}</span>
                        <span className="text-muted-foreground ml-1.5 text-[10px]">Group {c.allocatedGroup}</span>
                        <span className="text-amber-500 ml-1.5">
                          {c.misplacedDomains} domain{c.misplacedDomains === 1 ? "" : "s"} misplaced
                        </span>
                      </div>
                      {!isRunning && !isConfirming && (
                        <Button
                          size="sm" variant="outline"
                          className="h-7 gap-1.5 shrink-0 border-amber-500/40 text-amber-500 hover:text-amber-400 disabled:opacity-50"
                          onClick={() => setConfirming(c.clientTag)}
                          disabled={!canRun || runningTag !== null}
                          title={canRun ? "Move these domains to the correct instance" : "No Inboxing domains to auto-move — handle manually"}
                        >
                          <Play className="h-3.5 w-3.5" /> Run
                        </Button>
                      )}
                      {isRunning && (
                        <span className="inline-flex items-center gap-1.5 text-sky-500 shrink-0">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" /> {prog?.stage || "running…"}
                        </span>
                      )}
                    </div>

                    {/* per-hop breakdown */}
                    <div className="space-y-0.5 text-[11px] text-muted-foreground">
                      {c.groups.map((g) => (
                        <div key={g.sourceInstance} className="flex items-center gap-1.5">
                          <ArrowRightLeft className="h-3 w-3 shrink-0" />
                          <span>
                            {g.inboxingDomains.length} from <b className="text-foreground/80">{g.sourceLabel}</b> → <b className="text-foreground/80">{g.targetLabel}</b> ({g.inboxCount} inboxes)
                          </span>
                          {g.otherDomains.length > 0 && (
                            <span className="text-amber-500/80 inline-flex items-center gap-1">
                              <AlertTriangle className="h-3 w-3" />{g.otherDomains.length} non-Inboxing — move manually
                            </span>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* confirm gate */}
                    {isConfirming && (
                      <div className="flex items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-950/10 px-2.5 py-1.5">
                        <span className="text-[11px] text-amber-300">
                          Move {c.inboxingDomains} Inboxing domain{c.inboxingDomains === 1 ? "" : "s"} ({c.inboxCount} inboxes) to the correct instance? Source copy stays.
                        </span>
                        <span className="flex items-center gap-1.5 shrink-0">
                          <Button size="sm" className="h-6 px-2 bg-amber-600 hover:bg-amber-500" onClick={() => runClient(c)}>Confirm move</Button>
                          <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => setConfirming(null)}>Cancel</Button>
                        </span>
                      </div>
                    )}

                    {/* live / final progress */}
                    {prog && (
                      <div className="text-[11px]">
                        <span className={prog.stage === "done" ? "text-emerald-500" : "text-sky-500"}>
                          {prog.done} moved
                        </span>
                        {prog.uploading > 0 && <span className="text-sky-400"> · {prog.uploading} uploading</span>}
                        {prog.skipped > 0 && <span className="text-muted-foreground"> · {prog.skipped} skipped</span>}
                        {prog.failed > 0 && <span className="text-destructive"> · {prog.failed} failed</span>}
                        {prog.uploading > 0 && prog.stage === "done" && <span className="text-muted-foreground"> (safe to re-run to finish)</span>}
                        {prog.note && <span className="text-muted-foreground"> — {prog.note}</span>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )
        )}
      </CardContent>
    </Card>
  );
}
