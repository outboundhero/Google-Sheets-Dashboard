"use client";

// The replacement plan — one card for what used to be two (the group-plan
// roll-up and the page's own "Build plan" table built the same plan twice).
// Per client: how many burnt, how many get a replacement, what blocks the
// rest, and an Execute button that opens the confirm dialog for that client.
// The page owns the plan and the execution queue; this card only shows them.
import { useState, type ReactNode } from "react";
import { RefreshCw, Layers, ChevronDown, ChevronRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { PlanResult, ReserveDomain } from "@/lib/replacement/plan";

// short, unambiguous instance labels (outboundhero vs outboundclean both start "outbound")
const INSTANCE_SHORT: Record<string, string> = {
  outboundhero: "OH·B2B", cleaningoutbound: "CO·B2C", facilityreach: "FR·B2B", outboundclean: "OC·B2C",
};

interface ClientRow {
  clientTag: string;
  instance: string;
  burnt: number;
  replace: number;      // gets a like-for-like reserve, no blockers
  removeOnly: number;   // at cap → removed, no replacement
  blocked: number;      // wants a replacement but blocked (no reserve / redirect / campaign)
}

function Collapsible({ title, children }: { title: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs font-medium hover:bg-muted/40"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        {title}
      </button>
      {open && <div className="border-t p-3 space-y-3">{children}</div>}
    </div>
  );
}

// Reserve inventory — every untagged domain that has finished warmup (≥ 21
// days), per instance: provider, TLD, age, and whether it's pullable as a
// replacement (green dot) or inventory-only (gray).
function ReserveInventory({ reserveList }: { reserveList: ReserveDomain[] }) {
  const [filter, setFilter] = useState<"all" | "pullable" | "inventory">("all");
  const [search, setSearch] = useState("");

  const byInstance = new Map<string, ReserveDomain[]>();
  for (const r of reserveList) {
    const shouldInclude =
      (filter === "all" || (filter === "pullable" && r.pullable) || (filter === "inventory" && !r.pullable)) &&
      (search === "" || r.domain.toLowerCase().includes(search.toLowerCase()));
    if (!shouldInclude) continue;
    if (!byInstance.has(r.instance)) byInstance.set(r.instance, []);
    byInstance.get(r.instance)!.push(r);
  }
  const totalShown = [...byInstance.values()].reduce((s, l) => s + l.length, 0);

  return (
    <>
      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search domain…"
          className="text-xs px-2.5 py-1.5 rounded border bg-background flex-1 min-w-[200px] max-w-xs"
        />
        {(["all", "pullable", "inventory"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setFilter(k)}
            className={`text-xs px-2.5 py-1.5 rounded-full border capitalize transition-colors ${
              filter === k
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
            }`}
          >
            {k}
          </button>
        ))}
        <span className="text-[11px] text-muted-foreground ml-auto">{totalShown.toLocaleString("en-US")} shown</span>
      </div>

      {[...byInstance.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([inst, rows]) => (
        <div key={inst}>
          <div className="text-xs font-medium mb-1.5 flex items-center gap-2">
            <span>{inst}</span>
            <span className="text-muted-foreground font-normal">
              {rows.length.toLocaleString("en-US")} domain{rows.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="rounded-lg border divide-y max-h-[300px] overflow-y-auto">
            {rows.map((r) => (
              <div key={r.domain} className="grid grid-cols-[10px_1fr_80px_60px_60px_80px] gap-2 items-center px-3 py-1.5 text-xs">
                <span
                  className={`h-2 w-2 rounded-full ${r.pullable ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
                  title={r.pullable ? "Pullable as a replacement" : "Inventory-only (not pullable)"}
                />
                <span className="truncate">{r.domain}</span>
                <span className={`text-[10px] tabular-nums ${
                  r.provider === "outlook" ? "text-blue-400" :
                  r.provider === "google" ? "text-emerald-500" :
                  r.provider === "mixed" ? "text-amber-500" : "text-muted-foreground"
                }`}>{r.provider}</span>
                <span className={`text-[10px] ${r.isInfo ? "text-amber-500" : "text-muted-foreground"}`}>
                  {r.isInfo ? ".info" : "com/co"}
                </span>
                <span className={`text-[10px] ${r.blacklisted ? "text-red-500" : "text-muted-foreground"}`}>
                  {r.blacklisted ? "blocked" : "clean"}
                </span>
                <span className="text-[10px] text-muted-foreground text-right tabular-nums">{r.ageDays}d</span>
              </div>
            ))}
          </div>
        </div>
      ))}

      {totalShown === 0 && (
        <div className="text-xs text-muted-foreground text-center py-4">No domains match.</div>
      )}
    </>
  );
}

export function ReplacementPlanCard({
  plan, loading, error, builtAt, infoMode, onInfoModeChange, onRefresh, onExecute,
}: {
  plan: PlanResult | null;
  loading: boolean;
  error: string | null;
  builtAt: Date | null;
  infoMode: boolean;
  onInfoModeChange: (v: boolean) => void;
  onRefresh: () => void;
  onExecute: (clientTag: string, instance: string) => void;
}) {
  // per (client tag, instance) roll-up — only tagged burnt domains (untagged =
  // spare cleanup, not a client replacement).
  const clientRows: ClientRow[] = [];
  const groupFired = new Map<string, number>();   // "segment › group" -> count
  const blockerCounts = new Map<string, number>(); // blocker reason -> count (all clients)
  const blockersByClient = new Map<string, Map<string, number>>(); // per-row tooltip
  if (plan) {
    const acc = new Map<string, ClientRow>();
    for (const it of plan.items) {
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
  const skippedBurnt = plan?.skippedBurnt ?? [];

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium">
              <Layers className="h-4 w-4" />
              Replacement plan — burnt domains per client
              {plan?.infoMigration && <Badge variant="outline" className="border-amber-500/30 text-amber-500">.info migration mode</Badge>}
            </div>
            <div className="text-[11px] text-muted-foreground">
              Pull reserve → tag → set redirect → attach to campaigns → remove burnt. <b>Execute</b> runs it for one client now
              (confirm first); in auto mode the cron works through this same list on its own.
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {builtAt && !loading && (
              <span className="text-[10px] text-muted-foreground">as of {builtAt.toLocaleTimeString()}</span>
            )}
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Treat every .info domain as replaceable, not just burnt ones">
              <input type="checkbox" checked={infoMode} onChange={(e) => onInfoModeChange(e.target.checked)} />
              Migrate all .info
            </label>
            <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading} className="gap-2">
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              {loading ? "Building…" : "Refresh"}
            </Button>
          </div>
        </div>

        {error && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <span>Couldn&rsquo;t build the plan: {error}</span>
            <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading} className="h-7 text-xs">Try again</Button>
          </div>
        )}
        {!plan && loading && <div className="text-sm text-muted-foreground">Building the plan…</div>}

        {plan && (
          <>
            <div className="flex flex-wrap gap-4 text-sm">
              <span className="text-muted-foreground">{plan.infoMigration ? "To remove" : "Burnt (assigned)"} <b className="text-amber-500">{plan.burntCount.toLocaleString()}</b></span>
              <span className="text-muted-foreground">Replacement ready <b className="text-emerald-500">{totals.replace.toLocaleString()}</b></span>
              <span className="text-muted-foreground">Blocked <b className={totals.blocked > 0 ? "text-destructive" : "text-muted-foreground"}>{totals.blocked.toLocaleString()}</b></span>
              <span className="text-muted-foreground">Remove-only (at cap) <b>{totals.removeOnly.toLocaleString()}</b></span>
              {plan.unassignedBurntCount > 0 && (
                <span className="text-muted-foreground">Burnt spare/no-tag <b>{plan.unassignedBurntCount.toLocaleString()}</b> <span className="text-[10px]">(cleanup, not replaced)</span></span>
              )}
              <span className="text-muted-foreground" title="Outlook / Google = ready to pull as a replacement (pure provider, non-.info, ≥21d, clean). Total = every untagged domain ≥21d, regardless of TLD or provider.">
                Reserve (Outlook / Google · total ≥21d):
              </span>
              {Object.entries(plan.reserveReadyByInstance).map(([inst, c]) => (
                <span key={inst} className="text-muted-foreground">
                  {INSTANCE_SHORT[inst] ?? inst}: <b className={c.outlook > 0 ? "text-emerald-500" : "text-destructive"}>{c.outlook}</b>
                  {" / "}<b className={c.google > 0 ? "text-emerald-500" : "text-muted-foreground"}>{c.google}</b>
                  <span className="text-[10px] ml-1">· <b className="text-foreground">{c.total}</b> total</span>
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

            {/* flagged but on the Skip list — kept out of the plan on purpose */}
            {skippedBurnt.length > 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                <b>{skippedBurnt.length}</b> flagged domain{skippedBurnt.length === 1 ? " is" : "s are"} on the Skip list, so {skippedBurnt.length === 1 ? "it is" : "they are"} left
                alone: {skippedBurnt.slice(0, 8).map((s) => `${s.domain}${s.clientTag ? ` (${s.clientTag})` : ""}`).join(", ")}
                {skippedBurnt.length > 8 ? ` +${skippedBurnt.length - 8} more` : ""}. Unskip them in Flagged domains below to replace them.
              </div>
            )}

            {/* per-client-tag roll-up — what replacement does for each client */}
            {clientRows.length === 0 ? (
              <div className="text-xs text-muted-foreground italic">No assigned domains flagged right now.</div>
            ) : (
              <div className="rounded-lg border divide-y max-h-[420px] overflow-y-auto">
                <div className="grid grid-cols-[1fr_70px_70px_80px_100px_80px_90px] gap-2 px-3 py-2 text-[11px] text-muted-foreground font-medium bg-secondary sticky top-0 z-10">
                  <span>Client tag</span><span>Inst</span><span className="text-right">Burnt</span><span className="text-right">Replace</span><span className="text-right">Remove-only</span><span className="text-right">Blocked</span><span />
                </div>
                {clientRows.map((r) => {
                  const k = `${r.clientTag}|${r.instance}`;
                  return (
                  <div key={k} className="grid grid-cols-[1fr_70px_70px_80px_100px_80px_90px] gap-2 px-3 py-1.5 text-xs items-center">
                    <span className="font-medium">{r.clientTag}</span>
                    <span className="text-muted-foreground">{INSTANCE_SHORT[r.instance] ?? r.instance}</span>
                    <span className="text-right tabular-nums text-amber-500">{r.burnt}</span>
                    <span className="text-right tabular-nums text-emerald-500">{r.replace || "—"}</span>
                    <span className="text-right tabular-nums text-muted-foreground">{r.removeOnly || "—"}</span>
                    <span
                      className={`text-right tabular-nums ${r.blocked > 0 ? "text-destructive cursor-help" : "text-muted-foreground"}`}
                      title={blockerTooltip(k)}
                    >{r.blocked || "—"}</span>
                    <span className="text-right">
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onExecute(r.clientTag, r.instance)}>
                        Execute →
                      </Button>
                    </span>
                  </div>
                  );
                })}
              </div>
            )}

            <Collapsible title={<>Every burnt domain <span className="text-muted-foreground font-normal">— {plan.items.length.toLocaleString()} with the reserve each would get</span></>}>
              <div className="rounded-lg border divide-y max-h-[480px] overflow-y-auto">
                <div className="grid grid-cols-[1fr_75px_60px_45px_70px_1fr_1fr_55px] gap-2 px-3 py-2 text-[11px] text-muted-foreground font-medium bg-muted/30 sticky top-0">
                  <span>Burnt domain</span><span>Client</span><span>Inst</span><span>Type</span><span>Blacklist</span><span>Pull reserve → redirect</span><span>Attach to campaigns</span><span className="text-center">Cap</span>
                </div>
                {plan.items.map((it) => {
                  const bl = it.surbl === true || it.spamhaus === true;
                  const blDetail = [it.surbl === true ? "SURBL" : null, it.spamhaus === true ? "Spamhaus" : null].filter(Boolean).join(" + ");
                  return (
                  <div key={`${it.instance}:${it.burntDomain}`} className="grid grid-cols-[1fr_75px_60px_45px_70px_1fr_1fr_55px] gap-2 px-3 py-2 text-xs items-start">
                    <span className="truncate" title={it.reasons.join(" · ")}>{it.burntDomain}</span>
                    <span className="font-medium">{it.clientTag ?? <span className="text-destructive">?</span>}</span>
                    <span className="text-muted-foreground">{INSTANCE_SHORT[it.instance] ?? it.instance}</span>
                    <span className={it.provider === "outlook" ? "text-blue-400" : it.provider === "google" ? "text-red-400" : "text-amber-500"}>{it.provider === "outlook" ? "OL" : it.provider === "google" ? "GG" : it.provider}</span>
                    <span className={bl ? "text-red-400" : "text-muted-foreground"} title={bl ? `Blacklisted: ${blDetail}` : "Not blacklisted"}>
                      {bl ? `yes (${blDetail === "SURBL + Spamhaus" ? "both" : it.surbl ? "S" : "DBL"})` : "no"}
                    </span>
                    <span className="truncate">
                      {it.removeOnly ? (
                        <span className="text-muted-foreground italic">remove only — at cap, no replacement</span>
                      ) : (<>
                        {it.replacementDomain
                          ? <>
                              <span className="text-emerald-500">{it.replacementDomain}</span>
                              {it.replacementFrom && it.replacementFrom !== it.instance && (
                                <span className="text-sky-400" title={`Donor reserve — moved from ${INSTANCE_SHORT[it.replacementFrom] ?? it.replacementFrom} during execution (verify-all, donor copy auto-deletes in 24h)`}>
                                  {" "}(move from {INSTANCE_SHORT[it.replacementFrom] ?? it.replacementFrom})
                                </span>
                              )}
                            </>
                          : <span className="text-destructive">no reserve</span>}
                        {it.redirectUrl
                          ? <span className="text-muted-foreground"> → {it.redirectUrl.replace(/^https?:\/\//, "")}</span>
                          : <span className="text-destructive"> → no redirect</span>}
                      </>)}
                    </span>
                    <span className="truncate text-muted-foreground" title={it.targetCampaigns.map((c) => c.name).join(" · ")}>
                      {it.removeOnly ? "—"
                        : it.targetCampaigns.length > 0
                          ? `${it.targetCampaigns.length} campaign${it.targetCampaigns.length === 1 ? "" : "s"}`
                          : <span className="text-destructive">none</span>}
                    </span>
                    <span className="text-center tabular-nums text-muted-foreground">
                      {it.capCurrent}/{it.capMax}
                    </span>
                  </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted-foreground">
                <b>Top-up to cap:</b> every burnt domain is removed; replacements are added only up to the cap ({"{healthy}/{cap}"}). Rows marked <span className="italic">&ldquo;remove only — at cap&rdquo;</span> mean the client already has enough healthy domains, so the burnt one is removed but <b>no</b> replacement is added (and healthy domains are never removed). Red text = a replacement is blocked (missing redirect, no eligible campaign, or no ready reserve).
              </p>
            </Collapsible>

            <Collapsible title={<>Reserve inventory <span className="text-muted-foreground font-normal">
              — {plan.reserveList.length.toLocaleString("en-US")} untagged domain{plan.reserveList.length === 1 ? "" : "s"} ≥ 21d
              (<b className="text-emerald-500">{plan.reserveList.filter((r) => r.pullable).length.toLocaleString("en-US")}</b> pullable,{" "}
              <b>{plan.reserveList.filter((r) => !r.pullable).length.toLocaleString("en-US")}</b> inventory-only)</span></>}>
              <ReserveInventory reserveList={plan.reserveList} />
            </Collapsible>

            {plan.clientAudit.length > 0 && (
              <Collapsible title={<>Domain count per client <span className="text-muted-foreground font-normal">— by TLD &amp; provider, staying vs cap</span></>}>
                <div className="text-[11px] text-muted-foreground">Sorted by total. `.info` = to migrate off · `.com/.co` = keep. <b>Cap = staying/limit</b> (staying = domains kept after the removals in this plan). Red = over the limit (excess healthy left in place, 0 replacements added).</div>
                <div className="rounded-lg border divide-y max-h-[420px] overflow-y-auto">
                  <div className="grid grid-cols-[90px_110px_55px_55px_65px_55px_65px_75px] gap-2 px-3 py-2 text-[11px] text-muted-foreground font-medium bg-muted/30 sticky top-0">
                    <span>Client</span><span>Instance</span><span className="text-center">Total</span><span className="text-center">.info</span><span className="text-center">.com/.co</span><span className="text-center">other</span><span className="text-center">OL / GG</span><span className="text-center">Cap</span>
                  </div>
                  {plan.clientAudit.map((a) => (
                    <div key={`${a.clientTag}:${a.instance}`} className="grid grid-cols-[90px_110px_55px_55px_65px_55px_65px_75px] gap-2 px-3 py-2 text-xs items-center">
                      <span className="font-medium">{a.clientTag}</span>
                      <span className="text-muted-foreground">{INSTANCE_SHORT[a.instance] ?? a.instance}</span>
                      <span className="text-center tabular-nums">{a.total}</span>
                      <span className="text-center tabular-nums text-amber-500">{a.info || ""}</span>
                      <span className="text-center tabular-nums text-emerald-500">{a.comco || ""}</span>
                      <span className="text-center tabular-nums text-muted-foreground">{a.other || ""}</span>
                      <span className="text-center tabular-nums text-muted-foreground">{a.outlook} / {a.google}</span>
                      <span className={`text-center tabular-nums ${a.staying > a.capMax ? "text-destructive" : "text-muted-foreground"}`} title="staying (kept) / cap limit">{a.staying}/{a.capMax}</span>
                    </div>
                  ))}
                </div>
              </Collapsible>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
