"use client";

// Reserve warm-up forecast — "the next N domains finish warm-up on DATE".
// Read-only view of /api/replacement/warmup-forecast. Additive.
import { useState, useEffect, useCallback } from "react";
import { RefreshCw, CalendarClock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { WarmupForecast } from "@/lib/replacement/warmup-forecast";

const INSTANCE_SHORT: Record<string, string> = {
  outboundhero: "OH1", cleaningoutbound: "CO1", facilityreach: "FR2", outboundclean: "OC2",
};

function prettyDate(d: string): string {
  return new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function WarmupForecastCard() {
  const [data, setData] = useState<WarmupForecast | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/replacement/warmup-forecast", { cache: "no-store" });
      const j = (await res.json()) as WarmupForecast | { error: string };
      if ("error" in j) throw new Error(j.error);
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const id = setTimeout(load, 0); // deferred initial load
    return () => clearTimeout(id);
  }, [load]);

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium">
              <CalendarClock className="h-4 w-4" />
              Reserve warm-up forecast
            </div>
            <div className="text-[11px] text-muted-foreground">
              When untagged (reserve) domains finish the {data?.warmupDays ?? 21}-day warm-up and become pull-able for replacements.
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={load} disabled={loading} className="gap-2">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            {loading ? "Loading…" : "Refresh"}
          </Button>
        </div>

        {error && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}

        {data && (
          <>
            <div className="flex flex-wrap gap-4 text-sm">
              <span className="text-muted-foreground">Ready now <b className="text-emerald-500">{data.readyNow}</b></span>
              <span className="text-muted-foreground">Still warming <b className="text-amber-500">{data.warmingTotal}</b></span>
              <span className="text-muted-foreground">Of those pull-able when done <b className="text-foreground">{data.pullableTotal}</b></span>
            </div>

            {data.buckets.length === 0 ? (
              <div className="text-xs text-muted-foreground italic">
                Nothing is warming up — no untagged domains under {data.warmupDays} days old. New purchases will appear here.
              </div>
            ) : (
              <div className="rounded-lg border divide-y">
                {data.buckets.map((b) => (
                  <div key={b.date}>
                    <button
                      className="w-full flex items-center gap-3 px-3 py-2 text-xs hover:bg-muted/30 text-left"
                      onClick={() => setExpanded((e) => (e === b.date ? null : b.date))}
                    >
                      <span className="font-medium w-[70px]">{prettyDate(b.date)}</span>
                      <span className="text-muted-foreground w-[90px]">
                        {b.daysFromNow <= 0 ? "today" : b.daysFromNow === 1 ? "tomorrow" : `in ${b.daysFromNow} days`}
                      </span>
                      <span className="text-foreground"><b>{b.total}</b> domain{b.total === 1 ? "" : "s"} ready</span>
                      <span className="text-emerald-500">{b.pullable} pull-able</span>
                      <span className="text-muted-foreground ml-auto">
                        {Object.entries(b.byInstance).map(([i, n]) => `${INSTANCE_SHORT[i] ?? i} ${n}`).join(" · ")}
                      </span>
                    </button>
                    {expanded === b.date && (
                      <div className="px-3 pb-2 flex flex-wrap gap-x-4 gap-y-1">
                        {b.domains.map((w) => (
                          <span key={`${w.instance}:${w.domain}`} className={`text-[11px] font-mono ${w.pullable ? "text-muted-foreground" : "text-muted-foreground/50 line-through"}`} title={`${w.instance} · ${w.provider}${w.pullable ? "" : " · not pull-able (mixed/.info/blacklisted)"}`}>
                            {w.domain}
                          </span>
                        ))}
                      </div>
                    )}
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
