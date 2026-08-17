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
import { RefreshCw, Scale, ChevronRight, Copy, Check, Play, AlertTriangle, Scissors, ArrowLeftRight } from "lucide-react";
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
  ageDays: number;
  bucket: "unproven" | "ranked";
  score: number;
}
interface Row {
  clientTag: string;
  instance: string;
  tier: string;
  cap: number;
  staying: number;
  stayingUnproven: number;
  burnt: number;
  replacementPulls: number;
  fillNeeded: number;
  fillCandidates: string[];
  fillShort: number;
  trimNeeded: number;
  trimCandidates: TrimCandidate[];
  trimHeld: number;
  trimUnproven: number;
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

interface FillPreview {
  clientTag: string; instance: string; cap: number; staying: number;
  adding: number; stillShort: number; domains: string[]; campaigns: string[];
}
interface FillResult {
  ranClients: number;
  addedTotal: number;
  executed: { clientTag: string; instance: string; ok: boolean; added: number }[];
}

interface TrimPreview {
  clientTag: string; instance: string; cap: number; staying: number;
  trimming: number; unproven: number; domains: string[];
}
interface TrimResult {
  ranClients: number;
  trimmedTotal: number;
  note?: string;
  executed: {
    clientTag: string; instance: string; ok: boolean; trimmed: number;
    steps: { label: string; state: string; note?: string }[];
  }[];
}

interface MovePlan {
  targetInstance: string; short: number; stillShort: number; donorsExhausted: boolean;
  moving: { domain: string; fromInstance: string; provider: string }[];
}
interface MoveResult {
  movedTotal: number;
  uploadingTotal: number;
  note?: string;
  results: {
    targetInstance: string; fromInstance: string; requested: number;
    moved: string[]; uploading: string[];
    skipped: { domain: string; reason: string }[]; error?: string;
  }[];
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

  // Fill is confirm-first: the preview has to be fetched before the run button
  // appears, so nothing is added to a live client on a single mis-click.
  const [preview, setPreview] = useState<FillPreview[] | null>(null);
  const [busy, setBusy] = useState<"preview" | "run" | null>(null);
  const [ran, setRan] = useState<FillResult | null>(null);
  // Set when the preview came from a single row's button, so the run that
  // follows stays on that one client instead of falling back to the batch.
  const [scope, setScope] = useState<{ clientTag: string; instance: string } | null>(null);

  // Trim mirrors fill exactly — confirm-first, same scoping. Kept in its own
  // state so a staged trim preview can never be run by the fill button.
  const [trimPreview, setTrimPreview] = useState<TrimPreview[] | null>(null);
  const [trimBusy, setTrimBusy] = useState<"preview" | "run" | null>(null);
  const [trimRan, setTrimRan] = useState<TrimResult | null>(null);
  const [trimScope, setTrimScope] = useState<{ clientTag: string; instance: string } | null>(null);

  // Cross-instance move — covers a starving instance from a sibling that has
  // spare reserve. Same confirm-first shape as fill and trim.
  const [movePlan, setMovePlan] = useState<MovePlan[] | null>(null);
  const [moveBusy, setMoveBusy] = useState<"preview" | "run" | null>(null);
  const [moveRan, setMoveRan] = useState<MoveResult | null>(null);

  // Per-domain hold. Writes to the same replacement_skips the burnt flagging
  // already respects, so holding here also stops the domain being auto-removed.
  const [holding, setHolding] = useState<string | null>(null);

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

  const holdDomain = useCallback(async (instance: string, domain: string) => {
    setHolding(`${instance}:${domain}`); setErr(null);
    try {
      const res = await fetch("/api/replacement/skips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add",
          entries: [{ instance, domain, reason: "held from true-up trim" }],
        }),
      });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error || "Failed");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setHolding(null);
    }
  }, [load]);

  // `target` scopes the run to one client — the safe way to try a single one
  // before letting it loose on the whole batch.
  const callFill = useCallback(async (dryRun: boolean, target?: { clientTag: string; instance: string }) => {
    setBusy(dryRun ? "preview" : "run"); setErr(null);
    if (dryRun) setScope(target ?? null);
    try {
      const scoped = dryRun ? target ?? null : scope;
      const res = await fetch("/api/replacement/true-up/fill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scoped ? { ...scoped, dryRun } : { all: true, dryRun }),
      });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error || "Failed");
      if (dryRun) { setPreview(json.wouldRun as FillPreview[]); setRan(null); }
      else { setRan(json as FillResult); setPreview(null); setScope(null); await load(); }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }, [load, scope]);

  // Same shape as callFill. The trim hands domains back to the reserve — it
  // never schedules a vendor delete, so this is reversible by re-filling.
  const callTrim = useCallback(async (dryRun: boolean, target?: { clientTag: string; instance: string }) => {
    setTrimBusy(dryRun ? "preview" : "run"); setErr(null);
    if (dryRun) setTrimScope(target ?? null);
    try {
      const scoped = dryRun ? target ?? null : trimScope;
      const res = await fetch("/api/replacement/true-up/trim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scoped ? { ...scoped, dryRun } : { all: true, dryRun }),
      });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error || "Failed");
      if (dryRun) { setTrimPreview(json.wouldRun as TrimPreview[]); setTrimRan(null); }
      else { setTrimRan(json as TrimResult); setTrimPreview(null); setTrimScope(null); await load(); }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setTrimBusy(null);
    }
  }, [load, trimScope]);

  // Move is deliberately two-step: it only relocates domains. Tagging, the
  // redirect and campaign attach happen when the fill runs afterwards, against
  // senders that have actually landed on the target.
  const callMove = useCallback(async (dryRun: boolean) => {
    setMoveBusy(dryRun ? "preview" : "run"); setErr(null);
    try {
      const res = await fetch("/api/replacement/true-up/move-fill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun }),
      });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error || "Failed");
      if (dryRun) { setMovePlan(json.plan as MovePlan[]); setMoveRan(null); }
      else { setMoveRan(json as MoveResult); setMovePlan(null); await load(); }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setMoveBusy(null);
    }
  }, [load]);

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
            {data && data.totals.fillAvailable > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => callFill(true)}
                disabled={busy !== null || loading}
                className="gap-2"
              >
                <Play className="h-4 w-4" />
                {busy === "preview" ? "Checking…" : "Preview fill"}
              </Button>
            )}
            {data && data.totals.fillShort > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => callMove(true)}
                disabled={moveBusy !== null || trimBusy !== null || busy !== null || loading}
                className="gap-2"
              >
                <ArrowLeftRight className="h-4 w-4" />
                {moveBusy === "preview" ? "Checking…" : "Preview move"}
              </Button>
            )}
            {data && data.totals.trimNeeded > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => callTrim(true)}
                disabled={trimBusy !== null || busy !== null || loading}
                className="gap-2"
              >
                <Scissors className="h-4 w-4" />
                {trimBusy === "preview" ? "Checking…" : "Preview trim"}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={load} disabled={loading || busy !== null || trimBusy !== null} className="gap-2">
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              {loading ? "Calculating…" : "Calculate"}
            </Button>
          </div>
        </div>

        {err && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{err}</div>}

        {/* Confirm-first fill. This is the only thing on the card that changes
            anything — everything else reports. */}
        {preview && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-3 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-amber-500">
              <AlertTriangle className="h-4 w-4" />
              {scope
                ? `This will add domains to ${scope.clientTag} (${label(scope.instance)})`
                : "This will add domains to live clients"}
            </div>
            {preview.length === 0 ? (
              <div className="text-xs text-muted-foreground">
                Nothing runnable — every under-cap client is either out of reserve, missing a redirect, or has no
                eligible campaign.
              </div>
            ) : (
              <>
                <div className="text-[11px] text-muted-foreground">
                  {preview.length} client{preview.length === 1 ? "" : "s"} ·{" "}
                  {preview.reduce((s, p) => s + p.adding, 0)} domains. Tags them, sets the client redirect, attaches
                  them to the client&rsquo;s campaigns and whitelists them. Nothing is removed or deleted.
                </div>
                <div className="rounded border divide-y max-h-56 overflow-y-auto bg-background">
                  {preview.map((p) => (
                    <div key={`${p.clientTag}:${p.instance}`} className="px-3 py-2 text-[11px]">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">
                          {p.clientTag} <span className="text-muted-foreground">{label(p.instance)}</span>
                        </span>
                        <span className="tabular-nums text-muted-foreground">
                          {p.staying} → {p.staying + p.adding} of {p.cap}
                          {p.stillShort > 0 && <span className="text-destructive"> · still {p.stillShort} short</span>}
                        </span>
                      </div>
                      <div className="text-muted-foreground break-all">{p.domains.join(", ")}</div>
                      <div className="text-muted-foreground">→ {p.campaigns.join(", ")}</div>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => callFill(false)} disabled={busy !== null} className="gap-2">
                    <Play className="h-4 w-4" />
                    {busy === "run" ? "Running…" : `Run it — ${preview.reduce((s, p) => s + p.adding, 0)} domains`}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => { setPreview(null); setScope(null); }}
                    disabled={busy !== null}
                  >
                    Cancel
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Cross-instance move. Relocates stock only — the fill does the
            tagging and attaching once the senders land. */}
        {movePlan && (
          <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 px-3 py-3 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-violet-500">
              <ArrowLeftRight className="h-4 w-4" />
              Move reserve between instances
            </div>
            {movePlan.length === 0 || movePlan.every((p) => p.moving.length === 0) ? (
              <div className="text-xs text-muted-foreground">
                Nothing to move — no sibling instance has spare reserve for the ones that are short.
              </div>
            ) : (
              <>
                <div className="text-[11px] text-muted-foreground">
                  Moves domains only. They land on the target untagged, then the fill tags them, sets
                  the client redirect and attaches campaigns. Only Inboxing-provisioned domains can
                  move; the source copy stays until it is verified, then auto-deletes.
                </div>
                <div className="rounded border divide-y max-h-56 overflow-y-auto bg-background">
                  {movePlan.filter((p) => p.moving.length > 0).map((p) => {
                    const byDonor = new Map<string, string[]>();
                    for (const m of p.moving) {
                      byDonor.set(m.fromInstance, [...(byDonor.get(m.fromInstance) ?? []), m.domain]);
                    }
                    return (
                      <div key={p.targetInstance} className="px-3 py-2 text-[11px] space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="font-medium">
                            → {label(p.targetInstance)}
                            <span className="text-muted-foreground"> needs {p.short}</span>
                          </span>
                          <span className="tabular-nums text-muted-foreground">
                            moving {p.moving.length}
                            {p.stillShort > 0 && (
                              <span className="text-destructive"> · still {p.stillShort} short</span>
                            )}
                          </span>
                        </div>
                        {[...byDonor].map(([donor, doms]) => (
                          <div key={donor} className="text-muted-foreground break-all">
                            from {label(donor)} ({doms.length}): {doms.join(", ")}
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => callMove(false)} disabled={moveBusy !== null} className="gap-2">
                    <ArrowLeftRight className="h-4 w-4" />
                    {moveBusy === "run"
                      ? "Moving…"
                      : `Move ${movePlan.reduce((s, p) => s + p.moving.length, 0)} domains`}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setMovePlan(null)} disabled={moveBusy !== null}>
                    Cancel
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {moveRan && (
          <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 px-3 py-2 text-xs space-y-1">
            <div className="font-medium text-violet-500">
              Moved {moveRan.movedTotal} domain{moveRan.movedTotal === 1 ? "" : "s"}
              {moveRan.uploadingTotal > 0 && ` · ${moveRan.uploadingTotal} still uploading`}
            </div>
            {moveRan.results.map((r, i) => (
              <div key={`${r.fromInstance}:${r.targetInstance}:${i}`} className="text-muted-foreground">
                {r.error ? "✗" : "✓"} {label(r.fromInstance)} → {label(r.targetInstance)} —{" "}
                {r.moved.length}/{r.requested}
                {r.uploading.length > 0 && ` · ${r.uploading.length} uploading`}
                {r.skipped.length > 0 && (
                  <span className="text-destructive"> · {r.skipped.length} skipped</span>
                )}
                {r.error && <span className="text-destructive"> · {r.error}</span>}
                {/* The reason decides what happens next — "not an Inboxing
                    domain" means it can never move, so show it, don't bury it
                    in a count. */}
                {r.skipped.map((s) => (
                  <div key={s.domain} className="pl-4 text-destructive/80">
                    {s.domain} — {s.reason}
                  </div>
                ))}
              </div>
            ))}
            {moveRan.note && <div className="text-muted-foreground">{moveRan.note}</div>}
          </div>
        )}

        {/* Confirm-first trim. Reversible — trimmed domains go back to the
            reserve rather than to the vendor-delete queue. */}
        {trimPreview && (
          <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-3 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-sky-500">
              <Scissors className="h-4 w-4" />
              {trimScope
                ? `This will take domains off ${trimScope.clientTag} (${label(trimScope.instance)})`
                : "This will take domains off live clients"}
            </div>
            {trimPreview.length === 0 ? (
              <div className="text-xs text-muted-foreground">Nothing over cap right now.</div>
            ) : (
              <>
                <div className="text-[11px] text-muted-foreground">
                  {trimPreview.length} client{trimPreview.length === 1 ? "" : "s"} ·{" "}
                  {trimPreview.reduce((s, p) => s + p.trimming, 0)} domains. Detaches them from the
                  client&rsquo;s campaigns, removes the tag and clears the redirect. They go back to the
                  reserve untagged — nothing is deleted or cancelled, so a re-fill undoes this.
                </div>
                <div className="rounded border divide-y max-h-56 overflow-y-auto bg-background">
                  {trimPreview.map((p) => (
                    <div key={`${p.clientTag}:${p.instance}`} className="px-3 py-2 text-[11px]">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">
                          {p.clientTag} <span className="text-muted-foreground">{label(p.instance)}</span>
                        </span>
                        <span className="tabular-nums text-muted-foreground">
                          {p.staying} → {p.staying - p.trimming} of {p.cap}
                          {p.unproven > 0 && <span> · {p.unproven} unproven</span>}
                        </span>
                      </div>
                      <div className="text-muted-foreground break-all">{p.domains.join(", ")}</div>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => callTrim(false)} disabled={trimBusy !== null} className="gap-2">
                    <Scissors className="h-4 w-4" />
                    {trimBusy === "run"
                      ? "Running…"
                      : `Run it — ${trimPreview.reduce((s, p) => s + p.trimming, 0)} domains`}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => { setTrimPreview(null); setTrimScope(null); }}
                    disabled={trimBusy !== null}
                  >
                    Cancel
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {trimRan && (
          <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-xs space-y-1">
            <div className="font-medium text-sky-500">
              Trimmed {trimRan.trimmedTotal} domain{trimRan.trimmedTotal === 1 ? "" : "s"} across{" "}
              {trimRan.ranClients} client{trimRan.ranClients === 1 ? "" : "s"}
            </div>
            {trimRan.executed.map((e) => (
              <div key={`${e.clientTag}:${e.instance}`} className="text-muted-foreground">
                {e.ok ? "✓" : "✗"} {e.clientTag} {label(e.instance)} — {e.trimmed}
                {!e.ok && (
                  <span className="text-destructive">
                    {" "}· {e.steps.filter((s) => s.state === "failed").map((s) => s.label).join(", ")}
                  </span>
                )}
              </div>
            ))}
            {trimRan.note && <div className="text-muted-foreground">{trimRan.note}</div>}
          </div>
        )}

        {ran && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs space-y-1">
            <div className="font-medium text-emerald-500">
              Added {ran.addedTotal} domain{ran.addedTotal === 1 ? "" : "s"} across {ran.ranClients} client
              {ran.ranClients === 1 ? "" : "s"}
            </div>
            {ran.executed.map((e) => (
              <div key={`${e.clientTag}:${e.instance}`} className="text-muted-foreground">
                {e.ok ? "✓" : "✗"} {e.clientTag} {label(e.instance)} — {e.added}
                {!e.ok && <span className="text-destructive"> · check the queue for the failed step</span>}
              </div>
            ))}
          </div>
        )}

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
                              <b className="text-sky-500">{r.trimNeeded}</b>
                              {r.trimUnproven > 0 && (
                                <span className="text-muted-foreground text-[10px]"> ({r.trimUnproven} unproven)</span>
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
                              <div className="flex items-start justify-between gap-2">
                                <div className="text-[10px] text-muted-foreground uppercase tracking-wide">
                                  Would untag back to reserve — in trim order
                                  <span className="normal-case tracking-normal">
                                    {" "}· unproven first (under {data.ranking.minSentToTrim.toLocaleString()} sent or no
                                    reply figure, oldest of those first), then lowest reply rate · {r.stayingUnproven} of{" "}
                                    {r.staying} on this tag have no track record
                                    {r.trimHeld > 0 && (
                                      <span className="text-amber-500"> · {r.trimHeld} on hold, exempt</span>
                                    )}
                                  </span>
                                </div>
                                {r.trimNeeded > 0 && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-6 gap-1.5 text-[10px] shrink-0"
                                    disabled={trimBusy !== null || busy !== null || loading}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      callTrim(true, { clientTag: r.clientTag, instance: r.instance });
                                    }}
                                  >
                                    <Scissors className="h-3 w-3" />
                                    Trim just {r.clientTag}
                                  </Button>
                                )}
                              </div>
                              {r.trimCandidates.map((c) => (
                                <div key={c.domain} className="grid grid-cols-[1fr_74px_66px_84px_112px_84px_52px] gap-2 text-[11px] tabular-nums items-center">
                                  <span className="truncate">{c.domain}</span>
                                  <span className="text-right">
                                    <Badge
                                      variant="outline"
                                      className={`text-[9px] ${c.bucket === "unproven" ? "border-amber-500/30 text-amber-500" : "border-sky-500/30 text-sky-500"}`}
                                    >
                                      {c.bucket}
                                    </Badge>
                                  </span>
                                  <span className="text-right text-muted-foreground">{c.ageDays}d old</span>
                                  <span className="text-right text-muted-foreground">{c.sent.toLocaleString()} sent</span>
                                  <span className="text-right">
                                    {c.reply == null ? <span className="text-muted-foreground">no reply data</span> : `${c.reply.toFixed(2)}% reply`}
                                    {/* which window it was ranked on — a 15d rate is noisier and can
                                        read high next to a 30d one, so never hide the difference */}
                                    {c.replyWindow && (
                                      <span className={c.replyWindow === "15" ? "text-amber-500 text-[10px]" : "text-muted-foreground text-[10px]"}>
                                        {" "}({c.replyWindow}d)
                                      </span>
                                    )}
                                  </span>
                                  <span className="text-right text-muted-foreground">
                                    {c.bounce == null ? "—" : `${c.bounce.toFixed(2)}% bnc`}
                                  </span>
                                  {/* Hold a pick the ranking can't see a reason for. Also
                                      exempts it from burnt removal — same skip list. */}
                                  <button
                                    className="text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40"
                                    disabled={holding !== null}
                                    onClick={(e) => { e.stopPropagation(); holdDomain(r.instance, c.domain); }}
                                    title="Exempt this domain from the trim"
                                  >
                                    {holding === `${r.instance}:${c.domain}` ? "…" : "Hold"}
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                          {r.fillCandidates.length > 0 && (
                            <div className="space-y-1">
                              <div className="flex items-center justify-between gap-2">
                                <div className="text-[10px] text-muted-foreground uppercase tracking-wide">
                                  Reserve earmarked for this tag
                                </div>
                                {/* One client at a time — the batch button runs up to
                                    5, which is too much to eyeball on a first run. */}
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-6 gap-1.5 text-[10px]"
                                  disabled={busy !== null || loading}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    callFill(true, { clientTag: r.clientTag, instance: r.instance });
                                  }}
                                >
                                  <Play className="h-3 w-3" />
                                  Fill just {r.clientTag}
                                </Button>
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
              live campaign) · trim order: burnt (handled by replacement) → unproven, under{" "}
              {data.ranking.minSentToTrim.toLocaleString()} sent → lowest reply rate, 30-day where there is one, else
              15-day. Reply rate only; bounce is not scored here because it is already its own flagging threshold.
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
