"use client";

// Domains short — tier-aware "how many to add per b2b / b2c instance, per client
// tag" (Spencer 2026-08-04). Reads /api/replacement/shortfall. Observe-only:
// counts non-flagged domains that remain vs the tier-based live cap (20/40 b2b,
// 5/10 b2c) and shows the shortfall. Additive — nothing else on the tab changes.
import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Target } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface SideShort {
  instance: string; label: string; have: number; liveCap: number;
  totalTarget: number; short: number; excess: number;
}
interface TagRow { clientTag: string; tier: string; group: number; b2b: SideShort; b2c: SideShort }
interface InstRoll { instance: string; label: string; tier: string; clients: number; short: number; excess: number }
interface Resp {
  generatedFor: string; burntSource: string; tierSource: string;
  totalShort: number; byInstance: InstRoll[]; rows: TagRow[];
  error?: string;
}

function ShortCell({ s }: { s: SideShort }) {
  return (
    <span className="text-right tabular-nums whitespace-nowrap">
      <span className="text-muted-foreground">{s.have}/{s.liveCap}</span>{" "}
      {s.short > 0
        ? <b className="text-amber-500">short {s.short}</b>
        : s.excess > 0
          ? <span className="text-emerald-500">+{s.excess}</span>
          : <span className="text-muted-foreground">ok</span>}
    </span>
  );
}

export function ShortfallCard() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const res = await fetch("/api/replacement/shortfall", { cache: "no-store" });
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

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium">
              <Target className="h-4 w-4" />
              Domains short — buy per instance
              <Badge variant="outline" className="border-sky-500/30 text-sky-500">observe</Badge>
            </div>
            <div className="text-[11px] text-muted-foreground">
              Non-flagged domains that remain vs the tier live cap (20/40 B2B · 5/10 B2C), per client tag, per b2b/b2c
              instance independently. Flagged domains removed first, then trued up. Nothing is bought.
            </div>
          </div>
          <div className="flex items-center gap-2">
            {data && !loading && (
              <span className="text-[10px] text-muted-foreground">
                tiers: {data.tierSource === "client-tracker" ? "col K" : "default (all tier 1)"}
              </span>
            )}
            <Button size="sm" variant="outline" onClick={load} disabled={loading} className="gap-2">
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              {loading ? "Calculating…" : "Calculate"}
            </Button>
          </div>
        </div>

        {err && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{err}</div>}

        {data && (
          <>
            {/* per-instance roll-up — the "add this many to this instance" number */}
            <div className="flex flex-wrap gap-4 text-sm">
              <span className="text-muted-foreground">Total short <b className={data.totalShort > 0 ? "text-amber-500" : "text-emerald-500"}>{data.totalShort.toLocaleString()}</b></span>
              {data.byInstance.map((i) => (
                <span key={i.instance} className="text-muted-foreground">
                  {i.label} <span className="text-[10px]">({i.tier})</span> add{" "}
                  <b className={i.short > 0 ? "text-amber-500" : "text-muted-foreground"}>{i.short}</b>
                  {i.excess > 0 && <span className="text-emerald-500 text-[10px]"> · +{i.excess}</span>}
                </span>
              ))}
            </div>

            {data.rows.length === 0 ? (
              <div className="text-xs text-muted-foreground italic">No client tags with assigned domains found.</div>
            ) : (
              <div className="rounded-lg border divide-y max-h-[460px] overflow-y-auto">
                <div className="grid grid-cols-[1fr_50px_1fr_1fr] gap-2 px-3 py-2 text-[11px] text-muted-foreground font-medium bg-secondary sticky top-0 z-10">
                  <span>Client tag</span>
                  <span className="text-center">Tier</span>
                  <span className="text-right">B2B (have/cap)</span>
                  <span className="text-right">B2C (have/cap)</span>
                </div>
                {data.rows.map((r) => (
                  <div key={r.clientTag} className="grid grid-cols-[1fr_50px_1fr_1fr] gap-2 px-3 py-2 text-xs items-center">
                    <span className="font-medium">
                      {r.clientTag}
                      <span className="text-muted-foreground ml-1 text-[10px]">{r.b2b.label}/{r.b2c.label}</span>
                    </span>
                    <span className="text-center">
                      <Badge variant="outline" className="text-[9px]">{r.tier}</Badge>
                    </span>
                    <ShortCell s={r.b2b} />
                    <ShortCell s={r.b2c} />
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
