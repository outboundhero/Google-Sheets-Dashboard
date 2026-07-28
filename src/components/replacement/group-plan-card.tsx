"use client";

// Group-driven replacement plan — OBSERVE-ONLY. Runs the SAME replacement plan as
// the flat-guardrail preview, but burnt detection comes from Spencer's segmented
// threshold GROUPS (per-client-tag rule-sets). Lets him test what replacement
// WOULD do per client tag before the groups ever become the live detector.
// Self-contained: reads /api/replacement/plan-groups. Executes nothing. Additive —
// does not touch the existing guardrail plan.
import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Layers } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { PlanResult, PlanItem } from "@/lib/replacement/plan";

const INSTANCE_SHORT: Record<string, string> = {
  outboundhero: "OH1", cleaningoutbound: "CO1", facilityreach: "FR2", outboundclean: "OC2",
};

type Resp = ({ enabled: true } & PlanResult) | { enabled: false } | { error: string };

interface ClientRow {
  clientTag: string;
  instance: string;
  burnt: number;
  replace: number;      // gets a like-for-like reserve, no blockers
  removeOnly: number;   // at cap → removed, no replacement
  blocked: number;      // wants a replacement but blocked (no reserve / redirect / campaign)
}

export function GroupPlanCard() {
  const [resp, setResp] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [builtAt, setBuiltAt] = useState<Date | null>(null);

  const build = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch("/api/replacement/plan-groups", { cache: "no-store" });
      const d = (await r.json()) as Resp;
      if ("error" in d) throw new Error(d.error);
      setResp(d);
      setBuiltAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-refresh (Spencer 2026-07-27 Loom): build on open, rebuild every 4h
  // while the page stays open — the plan is never hours stale when someone looks.
  useEffect(() => {
    const t = setTimeout(build, 0); // deferred initial build
    const id = setInterval(build, 4 * 3600_000);
    return () => { clearTimeout(t); clearInterval(id); };
  }, [build]);

  const plan = resp && "enabled" in resp && resp.enabled ? resp : null;

  // per (client tag, instance) roll-up — only tagged burnt domains (untagged =
  // spare cleanup, not a client replacement).
  const clientRows: ClientRow[] = [];
  const groupFired = new Map<string, number>();   // "segment › group" -> count
  const blockerCounts = new Map<string, number>(); // blocker reason -> count (all clients)
  const blockersByClient = new Map<string, Map<string, number>>(); // per-row tooltip
  if (plan) {
    const acc = new Map<string, ClientRow>();
    for (const it of plan.items as PlanItem[]) {
      if (it.clientTag) {
        const k = `${it.clientTag}|${it.instance}`;
        let row = acc.get(k);
        if (!row) { row = { clientTag: it.clientTag, instance: it.instance, burnt: 0, replace: 0, removeOnly: 0, blocked: 0 }; acc.set(k, row); }
        row.burnt++;
        if (it.removeOnly) row.removeOnly++;
        else if (it.blockers.length === 0 && it.replacementDomain) row.replace++;
        else {
          row.blocked++;
          let m = blockersByClient.get(k);
          if (!m) { m = new Map(); blockersByClient.set(k, m); }
          for (const b of it.blockers) {
            m.set(b, (m.get(b) || 0) + 1);
            blockerCounts.set(b, (blockerCounts.get(b) || 0) + 1);
          }
        }
      }
      // reasons[0] is the "segment › group" label set by the plan builder
      const label = it.reasons[0];
      if (label && label.includes("›")) groupFired.set(label, (groupFired.get(label) || 0) + 1);
    }
    clientRows.push(...[...acc.values()].sort((a, b) => b.burnt - a.burnt || a.clientTag.localeCompare(b.clientTag)));
  }
  const firedList = [...groupFired.entries()].sort((a, b) => b[1] - a[1]);
  const blockerList = [...blockerCounts.entries()].sort((a, b) => b[1] - a[1]);
  const totals = clientRows.reduce(
    (t, r) => ({ replace: t.replace + r.replace, removeOnly: t.removeOnly + r.removeOnly, blocked: t.blocked + r.blocked }),
    { replace: 0, removeOnly: 0, blocked: 0 },
  );
  const blockerTooltip = (k: string): string | undefined => {
    const m = blockersByClient.get(k);
    if (!m) return undefined;
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ×${n}`).join("\n");
  };

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium">
              <Layers className="h-4 w-4" />
              Group-driven replacement plan
              <Badge variant="outline" className="border-sky-500/30 text-sky-500">observe</Badge>
            </div>
            <div className="text-[11px] text-muted-foreground">
              Burnt detection uses the threshold <b>groups</b> (SURBL/Spamhaus ignored), not the flat guardrails.
              Same downstream plan (pull reserve → tag → redirect → attach → remove). Nothing executes.
            </div>
          </div>
          <div className="flex items-center gap-2">
            {builtAt && !loading && (
              <span className="text-[10px] text-muted-foreground">as of {builtAt.toLocaleTimeString()} · auto-refreshes every 4h</span>
            )}
            <Button size="sm" variant="outline" onClick={build} disabled={loading} className="gap-2">
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              {loading ? "Building…" : "Build group plan"}
            </Button>
          </div>
        </div>

        {error && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}

        {resp && "enabled" in resp && !resp.enabled && (
          <div className="text-xs text-muted-foreground italic">
            Threshold groups are OFF. Turn them on and save in the “Threshold groups” editor above, then build.
          </div>
        )}

        {plan && (
          <>
            <div className="flex flex-wrap gap-4 text-sm">
              <span className="text-muted-foreground">Burnt (assigned) <b className="text-amber-500">{plan.burntCount.toLocaleString()}</b></span>
              <span className="text-muted-foreground">Replacement ready <b className="text-emerald-500">{totals.replace.toLocaleString()}</b></span>
              <span className="text-muted-foreground">Blocked <b className={totals.blocked > 0 ? "text-destructive" : "text-muted-foreground"}>{totals.blocked.toLocaleString()}</b></span>
              <span className="text-muted-foreground">Remove-only (at cap) <b>{totals.removeOnly.toLocaleString()}</b></span>
              {plan.unassignedBurntCount > 0 && (
                <span className="text-muted-foreground">Burnt spare/no-tag <b>{plan.unassignedBurntCount.toLocaleString()}</b> <span className="text-[10px]">(cleanup, not replaced)</span></span>
              )}
              <span className="text-muted-foreground" title="Outlook / Google ready-to-pull reserve per instance">Reserve (OL / GG):</span>
              {Object.entries(plan.reserveReadyByInstance).map(([inst, c]) => (
                <span key={inst} className="text-muted-foreground">
                  {INSTANCE_SHORT[inst] ?? inst}: <b className={c.outlook > 0 ? "text-emerald-500" : "text-destructive"}>{c.outlook}</b>
                  {" / "}<b className={c.google > 0 ? "text-emerald-500" : "text-muted-foreground"}>{c.google}</b>
                </span>
              ))}
            </div>

            {/* which segment › group fired, and how often */}
            {firedList.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {firedList.map(([label, n]) => (
                  <Badge key={label} variant="outline" className="font-normal">
                    {label} <span className="ml-1 text-amber-500 font-medium">{n}</span>
                  </Badge>
                ))}
              </div>
            )}

            {/* why replacements are blocked, and how often */}
            {blockerList.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-muted-foreground">Blocked because:</span>
                {blockerList.map(([reason, n]) => (
                  <Badge key={reason} variant="outline" className="font-normal border-destructive/30">
                    {reason} <span className="ml-1 text-destructive font-medium">{n}</span>
                  </Badge>
                ))}
              </div>
            )}

            {/* per-client-tag roll-up — what replacement would do for each client */}
            {clientRows.length === 0 ? (
              <div className="text-xs text-muted-foreground italic">No assigned domains flagged by the current groups.</div>
            ) : (
              <div className="rounded-lg border divide-y max-h-[420px] overflow-y-auto">
                <div className="grid grid-cols-[1fr_60px_70px_90px_100px_80px] gap-2 px-3 py-2 text-[11px] text-muted-foreground font-medium bg-secondary sticky top-0 z-10">
                  <span>Client tag</span><span>Inst</span><span className="text-right">Burnt</span><span className="text-right">Replace</span><span className="text-right">Remove-only</span><span className="text-right">Blocked</span>
                </div>
                {clientRows.map((r) => {
                  const k = `${r.clientTag}|${r.instance}`;
                  return (
                  <div key={k} className="grid grid-cols-[1fr_60px_70px_90px_100px_80px] gap-2 px-3 py-2 text-xs items-center">
                    <span className="font-medium">{r.clientTag}</span>
                    <span className="text-muted-foreground">{INSTANCE_SHORT[r.instance] ?? r.instance}</span>
                    <span className="text-right tabular-nums text-amber-500">{r.burnt}</span>
                    <span className="text-right tabular-nums text-emerald-500">{r.replace || "—"}</span>
                    <span className="text-right tabular-nums text-muted-foreground">{r.removeOnly || "—"}</span>
                    <span
                      className={`text-right tabular-nums ${r.blocked > 0 ? "text-destructive cursor-help" : "text-muted-foreground"}`}
                      title={blockerTooltip(k)}
                    >{r.blocked || "—"}</span>
                  </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
