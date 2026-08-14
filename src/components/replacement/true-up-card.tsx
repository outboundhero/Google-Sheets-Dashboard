"use client";

// True-up — "every client sits at exactly its tier's cap" (Nick 2026-08-13).
// Reads /api/replacement/true-up. OBSERVE-ONLY: nothing is tagged, untagged,
// bought or deleted from here.
//
// Two sides to it:
//   FILL — under cap, so pull reserves in. The reserve pool is shared across
//          tags, so "short" here means the stock genuinely isn't there — this
//          is the "no domains available for client tag X" surface Spencer asked
//          for on 2026-08-12.
//   TRIM — over cap, so untag the worst performers back into reserve. The
//          ranking is still provisional (waiting on Nick's answer on which
//          number defines "better performing"), which is why it only reports.
import { useState, useEffect, useCallback, useMemo } from "react";
import { RefreshCw, Scale, ChevronRight, Copy, Check } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { INSTANCE_SHORT_LABELS, ALL_INSTANCE_SLUGS } from "@/lib/bison-instances";

interface TrimCandidate {
  domain: string;
  sent: number;
  reply: number | null;
  replyWindow: "30" | "15" | null;
  bounce: number | null;
  score: number;
}
interface Row {
  clientTag: string;
  instance: string;
  tier: string;
  cap: number;
  staying: number;
  burnt: number;
  replacementPulls: number;
  fillNeeded: number;
  fillCandidates: string[];
  fillShort: number;
  trimNeeded: number;
  trimCandidates: TrimCandidate[];
  trimProtected: number;
  blockers: string[];
}
interface Resp {
  generatedFor: string;
  ranking: { minSentToTrim: number; bounceWeight: number };
  rows: Row[];
  totals: {
    tagsAtCap: number; tagsUnderCap: number; tagsOverCap: number;
    fillNeeded: number; fillAvailable: number; fillShort: number; trimNeeded: number;
  };
  byInstance: Record<string, { fillNeeded: number; fillAvailable: number; fillShort: number; trimNeeded: number }>;
  skipped: { clientTag: string; instance: string; reason: string }[];
  error?: string;
}

type Filter = "no-stock" | "fill" | "trim" | "all";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "no-stock", label: "No stock" },
  { key: "fill", label: "Under cap" },
  { key: "trim", label: "Over cap" },
  { key: "all", label: "All" },
];

function label(instance: string) {
  return INSTANCE_SHORT_LABELS[instance as keyof typeof INSTANCE_SHORT_LABELS] ?? instance;
}

export function TrueUpCard() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("no-stock");
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const res = await fetch("/api/replacement/true-up", { cache: "no-store" });
      const json = (await res.json()) as Resp;
      if (!res.ok || json.error) throw new Error(json.error || "Failed");
      setData(json);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }, []);

  const rows = useMemo(() => {
    if (!data) return [];
    const picked = data.rows.filter((r) => {
      if (filter === "no-stock") return r.fillShort > 0;
      if (filter === "fill") return r.fillNeeded > 0;
      if (filter === "trim") return r.trimNeeded > 0;
      return r.fillNeeded > 0 || r.trimNeeded > 0;
    });
    return picked.sort(
      (a, b) =>
        b.fillShort - a.fillShort ||
        b.fillNeeded - a.fillNeeded ||
        b.trimNeeded - a.trimNeeded ||
        a.clientTag.localeCompare(b.clientTag),
    );
  }, [data, filter]);

  // Actionable hand-off: the short list as "TAG  instance  n", ready to paste
  // into a buy request.
  const copyShort = useCallback(() => {
    if (!data) return;
    const lines = data.rows
      .filter((r) => r.fillShort > 0)
      .sort((a, b) => a.instance.localeCompare(b.instance) || b.fillShort - a.fillShort)
      .map((r) => `${r.clientTag}\t${label(r.instance)}\t${r.fillShort}`);
    navigator.clipboard.writeText(`Client tag\tInstance\tDomains short\n${lines.join("\n")}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [data]);

  useEffect(() => { const id = setTimeout(load, 0); return () => clearTimeout(id); }, [load]);

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium">
              <Scale className="h-4 w-4" />
              True-up — hold every client at its tier cap
              <Badge variant="outline" className="border-sky-500/30 text-sky-500">observe</Badge>
            </div>
            <div className="text-[11px] text-muted-foreground">
              Tier 0.5/1 = 20 B2B · 5 B2C, Tier 2 = 40 · 10. Under cap → pull reserves in (on top of what replacement
              already does for burnt domains); over cap → untag the worst back to reserve. Reserve is shared, so
              &ldquo;short&rdquo; means the stock isn&rsquo;t there. Reports only — nothing runs.
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={load} disabled={loading} className="gap-2">
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              {loading ? "Calculating…" : "Calculate"}
            </Button>
          </div>
        </div>

        {err && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{err}</div>}

        {data && (
          <>
            <div className="flex flex-wrap gap-4 text-sm">
              <span className="text-muted-foreground">At cap <b className="text-emerald-500">{data.totals.tagsAtCap}</b></span>
              <span className="text-muted-foreground">Under <b className="text-amber-500">{data.totals.tagsUnderCap}</b></span>
              <span className="text-muted-foreground">Over <b className="text-sky-500">{data.totals.tagsOverCap}</b></span>
              <span className="text-muted-foreground">
                Add <b>{data.totals.fillNeeded}</b> · reserve covers <b className="text-emerald-500">{data.totals.fillAvailable}</b>
                {data.totals.fillShort > 0 && <> · <b className="text-destructive">{data.totals.fillShort} short</b></>}
              </span>
              <span className="text-muted-foreground">Trim <b className="text-sky-500">{data.totals.trimNeeded}</b></span>
            </div>

            {/* per instance — makes it obvious the stock is in the wrong place */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {ALL_INSTANCE_SLUGS.filter((s) => data.byInstance[s]).map((s) => {
                const i = data.byInstance[s];
                return (
                  <div key={s} className="rounded-lg border px-3 py-2">
                    <div className="text-[11px] font-medium">{label(s)}</div>
                    <div className="text-[11px] text-muted-foreground tabular-nums">
                      add {i.fillNeeded} · have {i.fillAvailable}
                    </div>
                    <div className="text-[11px] tabular-nums">
                      {i.fillShort > 0
                        ? <b className="text-destructive">{i.fillShort} short</b>
                        : <span className="text-emerald-500">covered</span>}
                      {i.trimNeeded > 0 && <span className="text-muted-foreground"> · trim {i.trimNeeded}</span>}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex items-center justify-between gap-2">
              <div className="flex gap-1">
                {FILTERS.map((f) => (
                  <Button
                    key={f.key}
                    size="sm"
                    variant={filter === f.key ? "secondary" : "ghost"}
                    className="h-7 text-[11px]"
                    onClick={() => setFilter(f.key)}
                  >
                    {f.label}
                  </Button>
                ))}
              </div>
              {data.totals.fillShort > 0 && (
                <Button size="sm" variant="outline" className="h-7 gap-2 text-[11px]" onClick={copyShort}>
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  Copy short list
                </Button>
              )}
            </div>

            {rows.length === 0 ? (
              <div className="text-xs text-muted-foreground italic">Nothing to show for this filter.</div>
            ) : (
              <div className="rounded-lg border divide-y max-h-[460px] overflow-y-auto">
                <div className="grid grid-cols-[1fr_90px_44px_70px_110px_90px] gap-2 px-3 py-2 text-[11px] text-muted-foreground font-medium bg-secondary sticky top-0 z-10">
                  <span>Client tag</span>
                  <span>Instance</span>
                  <span className="text-center">Tier</span>
                  <span className="text-right">Have/cap</span>
                  <span className="text-right">Add</span>
                  <span className="text-right">Trim</span>
                </div>
                {rows.map((r) => {
                  const key = `${r.clientTag}:${r.instance}`;
                  const expandable = r.trimCandidates.length > 0 || r.fillCandidates.length > 0;
                  return (
                    <div key={key}>
                      <div
                        className={`grid grid-cols-[1fr_90px_44px_70px_110px_90px] gap-2 px-3 py-2 text-xs items-center ${expandable ? "cursor-pointer hover:bg-secondary/50" : ""}`}
                        onClick={() => expandable && setOpen(open === key ? null : key)}
                      >
                        <span className="font-medium flex items-center gap-1">
                          {expandable && (
                            <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${open === key ? "rotate-90" : ""}`} />
                          )}
                          {r.clientTag}
                        </span>
                        <span className="text-muted-foreground text-[11px]">{label(r.instance)}</span>
                        <span className="text-center"><Badge variant="outline" className="text-[9px]">{r.tier}</Badge></span>
                        <span className="text-right tabular-nums text-muted-foreground">
                          {r.staying}/{r.cap}
                          {r.burnt > 0 && <span className="text-amber-500"> −{r.burnt}</span>}
                        </span>
                        <span className="text-right tabular-nums">
                          {r.fillNeeded > 0 ? (
                            r.fillShort > 0
                              ? <b className="text-destructive">{r.fillShort} short of {r.fillNeeded}</b>
                              : <span className="text-emerald-500">+{r.fillNeeded} ready</span>
                          ) : <span className="text-muted-foreground">—</span>}
                        </span>
                        <span className="text-right tabular-nums">
                          {r.trimNeeded > 0 ? (
                            <>
                              <b className="text-sky-500">{r.trimCandidates.length}</b>
                              {r.trimProtected > 0 && (
                                <span className="text-muted-foreground text-[10px]"> /{r.trimNeeded}</span>
                              )}
                            </>
                          ) : <span className="text-muted-foreground">—</span>}
                        </span>
                      </div>

                      {open === key && (
                        <div className="px-3 pb-3 pt-1 bg-secondary/30 space-y-2">
                          {r.blockers.length > 0 && (
                            <div className="text-[11px] text-destructive">{r.blockers.join(" · ")}</div>
                          )}
                          {r.trimCandidates.length > 0 && (
                            <div className="space-y-1">
                              <div className="text-[10px] text-muted-foreground uppercase tracking-wide">
                                Would untag back to reserve — worst first
                                {r.trimProtected > 0 && (
                                  <span className="normal-case tracking-normal">
                                    {" "}· {r.trimProtected} held back (under {data.ranking.minSentToTrim} sent or no reply data)
                                  </span>
                                )}
                              </div>
                              {r.trimCandidates.map((c) => (
                                <div key={c.domain} className="grid grid-cols-[1fr_90px_110px_90px] gap-2 text-[11px] tabular-nums">
                                  <span className="truncate">{c.domain}</span>
                                  <span className="text-right text-muted-foreground">{c.sent.toLocaleString()} sent</span>
                                  <span className="text-right">
                                    {c.reply == null ? <span className="text-muted-foreground">no reply data</span> : `${c.reply.toFixed(2)}% reply`}
                                    {c.replyWindow && <span className="text-muted-foreground text-[10px]"> ({c.replyWindow}d)</span>}
                                  </span>
                                  <span className="text-right text-muted-foreground">
                                    {c.bounce == null ? "—" : `${c.bounce.toFixed(2)}% bnc`}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                          {r.fillCandidates.length > 0 && (
                            <div className="space-y-1">
                              <div className="text-[10px] text-muted-foreground uppercase tracking-wide">
                                Reserve earmarked for this tag
                              </div>
                              <div className="text-[11px] text-muted-foreground break-all">{r.fillCandidates.join(", ")}</div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="text-[10px] text-muted-foreground">
              {data.rows.length} client tag × instance pairs · {data.skipped.length} skipped (internal tag, no tier, or no
              live campaign) · trim ranked on 30-day reply rate, falling back to 15-day, protecting anything under{" "}
              {data.ranking.minSentToTrim.toLocaleString()} sent.
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
