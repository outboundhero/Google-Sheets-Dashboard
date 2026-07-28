"use client";

// End-of-day replacement report — dashboard view of what the system did on a
// given PST day (same data the Slack report sends). Read-only; self-contained
// (reads /api/replacement/daily-report). Additive.
import { useState, useEffect, useCallback } from "react";
import { RefreshCw, FileText, ChevronLeft, ChevronRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { DailyReplacementReport } from "@/lib/replacement/daily-report";

const INSTANCE_SHORT: Record<string, string> = {
  outboundhero: "OH1", cleaningoutbound: "CO1", facilityreach: "FR2", outboundclean: "OC2",
};

function pstToday(): string {
  return new Date(Date.now() - 8 * 3600_000).toISOString().slice(0, 10);
}
function shiftDay(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function DailyReportCard() {
  const [date, setDate] = useState(pstToday());
  const [report, setReport] = useState<DailyReplacementReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (d: string) => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/replacement/daily-report?date=${d}`, { cache: "no-store" });
      const j = (await res.json()) as DailyReplacementReport | { error: string };
      if ("error" in j) throw new Error(j.error);
      setReport(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }, []);

  const go = (days: number) => {
    const d = shiftDay(date, days);
    setDate(d);
    load(d);
  };

  // load today's report on open (arrows/refresh stay manual)
  useEffect(() => {
    const id = setTimeout(() => load(pstToday()), 0); // deferred initial load
    return () => clearTimeout(id);
  }, [load]);

  const acted = report
    ? report.totals.tagged + report.totals.redirect_set + report.totals.attached + report.totals.removed + report.totals.error > 0
    : false;

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium">
              <FileText className="h-4 w-4" />
              Daily report — what replacement did
            </div>
            <div className="text-[11px] text-muted-foreground">
              Per PST day, from the audit log. Same content as the end-of-day Slack report.
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => go(-1)} disabled={loading} className="h-8 px-2">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-xs tabular-nums text-muted-foreground w-[84px] text-center">{date}</span>
            <Button size="sm" variant="ghost" onClick={() => go(1)} disabled={loading || date >= pstToday()} className="h-8 px-2">
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="outline" onClick={() => load(date)} disabled={loading} className="gap-2">
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              {loading ? "Building…" : "Load report"}
            </Button>
          </div>
        </div>

        {error && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}

        {report && (
          <>
            <div className="flex flex-wrap gap-4 text-sm items-center">
              <Badge variant="outline" className={report.mode === "observe" ? "border-emerald-500/30 text-emerald-500" : "border-amber-500/30 text-amber-500"}>
                mode: {report.mode}
              </Badge>
              <Badge variant="outline">detector: {report.detector}</Badge>
              {acted ? (
                <>
                  <span className="text-muted-foreground">Removed <b className="text-foreground">{report.totals.removed}</b></span>
                  <span className="text-muted-foreground">Tagged <b className="text-foreground">{report.totals.tagged}</b></span>
                  <span className="text-muted-foreground">Attached <b className="text-foreground">{report.totals.attached}</b></span>
                  <span className="text-muted-foreground">Redirects <b className="text-foreground">{report.totals.redirect_set}</b></span>
                  <span className="text-muted-foreground">Errors <b className={report.totals.error > 0 ? "text-destructive" : "text-foreground"}>{report.totals.error}</b></span>
                </>
              ) : (
                <span className="text-muted-foreground italic">No execution activity this day.</span>
              )}
            </div>

            <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
              <span>Detection now: <b className="text-amber-500">{report.detection.burnt}</b> burnt · <b className="text-emerald-500">{report.detection.ready}</b> ready · <b className="text-destructive">{report.detection.blocked}</b> blocked · {report.detection.removeOnly} remove-only</span>
              <span>Pending cancellations: <b className="text-foreground">{report.pendingCancellations}</b>{report.nextCancellation ? ` (next: ${report.nextCancellation.slice(0, 10)})` : ""}</span>
            </div>

            {report.byClient.length > 0 && (
              <div className="rounded-lg border divide-y max-h-[320px] overflow-y-auto">
                <div className="grid grid-cols-[1fr_60px_80px_80px_80px_80px_70px] gap-2 px-3 py-2 text-[11px] text-muted-foreground font-medium bg-secondary sticky top-0 z-10">
                  <span>Client tag</span><span>Inst</span><span className="text-right">Removed</span><span className="text-right">Tagged</span><span className="text-right">Attached</span><span className="text-right">Redirects</span><span className="text-right">Errors</span>
                </div>
                {report.byClient.map((c) => (
                  <div key={`${c.clientTag}|${c.instance}`} className="grid grid-cols-[1fr_60px_80px_80px_80px_80px_70px] gap-2 px-3 py-2 text-xs items-center">
                    <span className="font-medium">{c.clientTag}</span>
                    <span className="text-muted-foreground">{INSTANCE_SHORT[c.instance] ?? c.instance}</span>
                    <span className="text-right tabular-nums">{c.removed || "—"}</span>
                    <span className="text-right tabular-nums">{c.tagged || "—"}</span>
                    <span className="text-right tabular-nums">{c.attached || "—"}</span>
                    <span className="text-right tabular-nums">{c.redirects || "—"}</span>
                    <span className={`text-right tabular-nums ${c.errors > 0 ? "text-destructive" : ""}`}>{c.errors || "—"}</span>
                  </div>
                ))}
              </div>
            )}

            {report.errors.length > 0 && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-1 max-h-[200px] overflow-y-auto">
                {report.errors.map((e, i) => (
                  <div key={i} className="text-xs text-destructive">
                    {e.at.slice(11, 16)} · {e.clientTag ?? "—"} {e.domain ?? ""} — {e.detail ?? "error"}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
