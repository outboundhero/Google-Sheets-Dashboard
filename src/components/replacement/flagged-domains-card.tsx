"use client";

/**
 * Flagged domains — THE actionable surface for the replacement system
 * (Spencer Aug-11 Loom: "this is the core of everything").
 *
 *  • Every domain the threshold groups currently flag, reason-first:
 *    segment › group + why, then the stats — sortable by any column.
 *  • Filters: include search / exclude terms, instance, client tag,
 *    segment, group, and WHEN it entered the flagged system.
 *  • Drag or click rows to select (like the domains view), Skip in bulk.
 *  • Skipped domains live in a COLLAPSED queue below; unskip re-enters the
 *    next replacement cycle. A skipped domain whose metrics recovered bumps
 *    ITSELF off the queue automatically on load.
 *
 * Replaces both the editor's inline preview and the old SkipCard.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ChevronDown, ChevronRight, ChevronUp, Flag, Loader2, PauseCircle, PlayCircle, RefreshCw,
} from "lucide-react";
import { INSTANCE_SHORT_LABELS, ALL_INSTANCE_SLUGS } from "@/lib/bison-instances";

interface FlaggedRow {
  instance: string;
  domain: string;
  clientTag: string | null;
  sent: number;
  reply_15: number | null;
  reply_30: number | null;
  bounce_30f15: number | null;
  segmentName: string;
  groupName: string;
  reasons: string[];
  firstFlaggedAt?: string | null;
}
interface DetectResp {
  enabled: boolean;
  scanned: number;
  flaggedCount: number;
  bySegment: Record<string, number>;
  candidates: FlaggedRow[];
  error?: string;
}
interface SkipRow { instance: string; domain: string; reason: string | null; skipped_at: string }

const short = INSTANCE_SHORT_LABELS as Record<string, string>;
const k = (instance: string, domain: string) => `${instance}:${domain.toLowerCase()}`;

type SortKey = "reason" | "domain" | "tag" | "instance" | "sent" | "r15" | "r30" | "bounce" | "added";
type AddedFilter = "any" | "today" | "7d" | "older";

const sortVal = (r: FlaggedRow, key: SortKey): string | number => {
  switch (key) {
    case "reason": return `${r.segmentName} › ${r.groupName}`;
    case "domain": return r.domain;
    case "tag": return r.clientTag ?? "";
    case "instance": return r.instance;
    case "sent": return r.sent;
    case "r15": return r.reply_15 ?? -1;
    case "r30": return r.reply_30 ?? -1;
    case "bounce": return r.bounce_30f15 ?? -1;
    case "added": return r.firstFlaggedAt ?? "";
  }
};

export function FlaggedDomainsCard() {
  const [data, setData] = useState<DetectResp | null>(null);
  const [skips, setSkips] = useState<SkipRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);

  // filters / sort / selection
  const [search, setSearch] = useState("");
  const [exclude, setExclude] = useState("");
  const [fInstance, setFInstance] = useState("all");
  const [fTag, setFTag] = useState("all");
  const [fSegment, setFSegment] = useState("all");
  const [fGroup, setFGroup] = useState("all");
  const [fAdded, setFAdded] = useState<AddedFilter>("any");
  const [sortKey, setSortKey] = useState<SortKey>("reason");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [skippedOpen, setSkippedOpen] = useState(false);
  const [selSkips, setSelSkips] = useState<Set<string>>(new Set());
  const dragMode = useRef<null | "add" | "remove">(null);

  useEffect(() => {
    const up = () => { dragMode.current = null; };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError(null); setNote(null);
    try {
      const [dRes, sRes] = await Promise.all([
        fetch("/api/replacement/detect-groups", { cache: "no-store" }),
        fetch("/api/replacement/skips", { cache: "no-store" }),
      ]);
      const d = (await dRes.json().catch(() => null)) as DetectResp | null;
      const s = await sRes.json().catch(() => null);
      if (!dRes.ok || !d || d.error) throw new Error(d?.error || `HTTP ${dRes.status}`);
      let skipRows: SkipRow[] = (sRes.ok && s?.skips) || [];

      // Spencer: a skipped domain whose metrics recovered "bumps itself off"
      // the skip queue — auto-unskip anything no longer flagged.
      if (d.enabled) {
        const flaggedKeys = new Set(d.candidates.map((c) => k(c.instance, c.domain)));
        const recovered = skipRows.filter((r) => !flaggedKeys.has(k(r.instance, r.domain)));
        if (recovered.length > 0) {
          const res = await fetch("/api/replacement/skips", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "remove", entries: recovered.map((r) => ({ instance: r.instance, domain: r.domain })) }),
          });
          if (res.ok) {
            skipRows = skipRows.filter((r) => flaggedKeys.has(k(r.instance, r.domain)));
            setNote(`${recovered.length} skipped domain(s) recovered — removed from the skip queue automatically.`);
          }
        }
      }

      setData(d);
      setSkips(skipRows);
      setSel(new Set());
      setSelSkips(new Set());
      setAsOf(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }, []);

  // auto-load on mount (deferred — react-hooks forbids sync setState in effects)
  useEffect(() => { const t = setTimeout(load, 0); return () => clearTimeout(t); }, [load]);

  const skipKeys = new Set(skips.map((s) => k(s.instance, s.domain)));
  const all = data?.candidates ?? [];
  const active = all.filter((c) => !skipKeys.has(k(c.instance, c.domain)));
  const skippedRows = skips.map((s) => ({
    skip: s,
    cand: all.find((c) => k(c.instance, c.domain) === k(s.instance, s.domain)) ?? null,
  }));

  // filter options from the data itself
  const tags = [...new Set(active.map((c) => c.clientTag).filter(Boolean) as string[])].sort();
  const segments = [...new Set(active.map((c) => c.segmentName))].sort();
  const groups = [...new Set(active.filter((c) => fSegment === "all" || c.segmentName === fSegment).map((c) => c.groupName))].sort();

  const addedMatch = (r: FlaggedRow): boolean => {
    if (fAdded === "any") return true;
    if (!r.firstFlaggedAt) return false;
    const age = Date.now() - new Date(r.firstFlaggedAt).getTime();
    if (fAdded === "today") return age < 86_400_000;
    if (fAdded === "7d") return age < 7 * 86_400_000;
    return age >= 7 * 86_400_000; // older
  };
  const excludeTerms = exclude.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  const rowText = (r: FlaggedRow) =>
    `${r.domain} ${r.clientTag ?? ""} ${r.segmentName} ${r.groupName} ${r.reasons.join(" ")}`.toLowerCase();

  const filtered = active.filter((r) =>
    (fInstance === "all" || r.instance === fInstance) &&
    (fTag === "all" || r.clientTag === fTag) &&
    (fSegment === "all" || r.segmentName === fSegment) &&
    (fGroup === "all" || r.groupName === fGroup) &&
    addedMatch(r) &&
    (search.trim() === "" || rowText(r).includes(search.trim().toLowerCase())) &&
    !excludeTerms.some((t) => rowText(r).includes(t)),
  ).sort((a, b) => {
    const av = sortVal(a, sortKey), bv = sortVal(b, sortKey);
    const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
    return cmp !== 0 ? cmp * sortDir : a.domain.localeCompare(b.domain);
  });

  const setSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setSortDir(key === "sent" || key === "bounce" ? -1 : 1); }
  };

  const applySel = (key: string, mode: "add" | "remove") =>
    setSel((prev) => {
      const next = new Set(prev);
      if (mode === "add") next.add(key); else next.delete(key);
      return next;
    });

  const post = async (action: "add" | "remove", entries: { instance: string; domain: string; reason?: string }[]) => {
    if (entries.length === 0) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/replacement/skips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, entries }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || d?.error) throw new Error(d?.error || `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const skipSelected = () =>
    post("add", filtered
      .filter((r) => sel.has(k(r.instance, r.domain)))
      .map((r) => ({ instance: r.instance, domain: r.domain, reason: `${r.segmentName} › ${r.groupName}` })));
  const unskipSelected = () =>
    post("remove", skips
      .filter((s) => selSkips.has(k(s.instance, s.domain)))
      .map((s) => ({ instance: s.instance, domain: s.domain })));

  const allSelected = filtered.length > 0 && filtered.every((r) => sel.has(k(r.instance, r.domain)));
  const Arrow = ({ col }: { col: SortKey }) =>
    sortKey !== col ? null : sortDir === 1 ? <ChevronUp className="h-3 w-3 inline" /> : <ChevronDown className="h-3 w-3 inline" />;
  const th = (label: string, col: SortKey, cls = "") => (
    <button className={`text-left font-medium hover:text-foreground ${cls}`} onClick={() => setSort(col)}>
      {label} <Arrow col={col} />
    </button>
  );

  return (
    <Card>
      <CardContent className="p-5 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <div className="text-sm font-medium flex items-center gap-2">
              <Flag className="h-4 w-4" />
              Flagged domains — why, and what to skip
            </div>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Everything the threshold groups currently flag. Drag or click rows to select, then Skip —
              skipped domains are never replaced, removed, or counted, and drop off the queue by themselves when they recover.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {asOf && <span className="text-[10px] text-muted-foreground">as of {asOf}</span>}
            <Button size="sm" variant="outline" onClick={load} disabled={loading} className="gap-2">
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              {loading ? "Scanning…" : "Refresh"}
            </Button>
          </div>
        </div>

        {error && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}
        {note && <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">{note}</div>}

        {data && !data.enabled && (
          <p className="text-sm text-muted-foreground">Threshold groups are OFF — turn them on and save in the editor above.</p>
        )}

        {data && data.enabled && (
          <>
            <div className="flex flex-wrap gap-4 text-sm">
              <span className="text-muted-foreground">Scanned <b className="text-foreground">{data.scanned.toLocaleString()}</b></span>
              <span className="text-muted-foreground">Flagged <b className="text-amber-500">{active.length.toLocaleString()}</b></span>
              <span className="text-muted-foreground">Skipped <b className="text-foreground">{skips.length}</b></span>
              {Object.entries(data.bySegment).map(([s, n]) => (
                <span key={s} className="text-muted-foreground text-xs self-center">{s}: <b className="text-foreground">{n}</b></span>
              ))}
            </div>

            {/* filter toolbar */}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <input
                value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search domain / tag / reason…"
                className="px-2 py-1.5 rounded-lg border bg-background w-56"
              />
              <input
                value={exclude} onChange={(e) => setExclude(e.target.value)} placeholder="Exclude (comma terms)"
                className="px-2 py-1.5 rounded-lg border bg-background w-44"
              />
              <select value={fInstance} onChange={(e) => setFInstance(e.target.value)} className="px-2 py-1.5 rounded-lg border bg-background">
                <option value="all">All instances</option>
                {ALL_INSTANCE_SLUGS.map((s) => <option key={s} value={s}>{short[s] ?? s}</option>)}
              </select>
              <select value={fTag} onChange={(e) => setFTag(e.target.value)} className="px-2 py-1.5 rounded-lg border bg-background">
                <option value="all">All tags</option>
                {tags.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <select value={fSegment} onChange={(e) => { setFSegment(e.target.value); setFGroup("all"); }} className="px-2 py-1.5 rounded-lg border bg-background max-w-[220px]">
                <option value="all">All segments</option>
                {segments.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <select value={fGroup} onChange={(e) => setFGroup(e.target.value)} className="px-2 py-1.5 rounded-lg border bg-background">
                <option value="all">All groups</option>
                {groups.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
              <select value={fAdded} onChange={(e) => setFAdded(e.target.value as AddedFilter)} className="px-2 py-1.5 rounded-lg border bg-background">
                <option value="any">Added: any time</option>
                <option value="today">Added: today</option>
                <option value="7d">Added: last 7 days</option>
                <option value="older">Added: older than 7d</option>
              </select>
            </div>

            {/* selection / actions */}
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => {
                    if (allSelected) setSel(new Set());
                    else setSel(new Set(filtered.map((r) => k(r.instance, r.domain))));
                  }}
                />
                Select all ({filtered.length.toLocaleString()} filtered)
              </label>
              {sel.size > 0 && (
                <Button size="sm" variant="ghost" onClick={() => setSel(new Set())} className="h-7 text-xs text-muted-foreground">
                  Clear ({sel.size})
                </Button>
              )}
              <Button size="sm" onClick={skipSelected} disabled={busy || sel.size === 0} className="gap-1.5 h-7 text-xs ml-auto">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PauseCircle className="h-3.5 w-3.5" />}
                Skip {sel.size > 0 ? sel.size : ""} selected
              </Button>
            </div>

            {/* the table */}
            <div className="rounded-lg border max-h-[520px] overflow-y-auto select-none">
              <div className="grid grid-cols-[minmax(180px,1.2fr)_70px_65px_minmax(170px,1.3fr)_65px_60px_60px_60px_78px_minmax(200px,1.6fr)] gap-2 px-3 py-2 text-[11px] text-muted-foreground bg-muted/40 sticky top-0 z-10">
                {th("Domain", "domain")}
                {th("Tag", "tag")}
                {th("Inst", "instance")}
                {th("Reason (segment › group)", "reason")}
                {th("Sent", "sent", "text-right")}
                {th("R15", "r15", "text-right")}
                {th("R30", "r30", "text-right")}
                {th("Bnc", "bounce", "text-right")}
                {th("Added", "added")}
                <span className="font-medium">Why (conditions)</span>
              </div>
              {filtered.length === 0 && (
                <div className="px-3 py-4 text-xs text-muted-foreground">Nothing matches the current filters.</div>
              )}
              {filtered.slice(0, 500).map((r) => {
                const key = k(r.instance, r.domain);
                const selected = sel.has(key);
                return (
                  <div
                    key={key}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      dragMode.current = selected ? "remove" : "add";
                      applySel(key, dragMode.current);
                    }}
                    onMouseEnter={() => { if (dragMode.current) applySel(key, dragMode.current); }}
                    className={`grid grid-cols-[minmax(180px,1.2fr)_70px_65px_minmax(170px,1.3fr)_65px_60px_60px_60px_78px_minmax(200px,1.6fr)] gap-2 px-3 py-1.5 text-xs items-center border-t cursor-pointer ${selected ? "bg-sky-500/15" : "hover:bg-muted/40"}`}
                  >
                    <span className="font-mono truncate">{r.domain}</span>
                    <span className="font-medium truncate">{r.clientTag ?? "—"}</span>
                    <span className="text-muted-foreground">{short[r.instance] ?? r.instance}</span>
                    <span className="truncate" title={`${r.segmentName} › ${r.groupName}`}>
                      {r.segmentName} <span className="text-muted-foreground">› {r.groupName}</span>
                    </span>
                    <span className="text-right tabular-nums">{r.sent.toLocaleString()}</span>
                    <span className="text-right tabular-nums">{r.reply_15 ?? "—"}</span>
                    <span className="text-right tabular-nums">{r.reply_30 ?? "—"}</span>
                    <span className="text-right tabular-nums">{r.bounce_30f15 ?? "—"}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {r.firstFlaggedAt ? new Date(r.firstFlaggedAt).toLocaleDateString([], { month: "numeric", day: "numeric" }) : "—"}
                    </span>
                    <span className="text-muted-foreground truncate" title={r.reasons.join(" · ")}>{r.reasons.join(" · ")}</span>
                  </div>
                );
              })}
              {filtered.length > 500 && (
                <div className="px-3 py-1.5 text-[11px] text-muted-foreground border-t">+{filtered.length - 500} more — narrow the filters to see them.</div>
              )}
            </div>

            {/* collapsed skipped queue */}
            {skips.length > 0 && (
              <div className="rounded-lg border">
                <button
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium hover:bg-muted/40"
                  onClick={() => setSkippedOpen((o) => !o)}
                >
                  {skippedOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  Skipped ({skips.length}) — still flagged by current metrics, held out of replacement
                </button>
                {skippedOpen && (
                  <div className="border-t">
                    <div className="flex items-center justify-end px-3 py-1.5">
                      <Button size="sm" variant="outline" onClick={unskipSelected} disabled={busy || selSkips.size === 0} className="gap-1.5 h-7 text-xs">
                        <PlayCircle className="h-3.5 w-3.5" />
                        Unskip {selSkips.size > 0 ? selSkips.size : ""} selected
                      </Button>
                    </div>
                    <div className="max-h-64 overflow-y-auto divide-y border-t">
                      {skippedRows.map(({ skip, cand }) => {
                        const key = k(skip.instance, skip.domain);
                        return (
                          <label key={key} className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-muted/40">
                            <input
                              type="checkbox"
                              checked={selSkips.has(key)}
                              onChange={() => setSelSkips((prev) => {
                                const next = new Set(prev);
                                if (next.has(key)) next.delete(key); else next.add(key);
                                return next;
                              })}
                            />
                            <span className="font-mono truncate max-w-[240px]">{skip.domain}</span>
                            <Badge variant="outline" className="text-[10px]">{short[skip.instance] ?? skip.instance}</Badge>
                            {cand?.clientTag && <Badge variant="outline" className="text-[10px]">{cand.clientTag}</Badge>}
                            <span className="text-muted-foreground truncate flex-1" title={skip.reason || undefined}>{skip.reason}</span>
                            <span className="text-muted-foreground shrink-0">skipped {new Date(skip.skipped_at).toLocaleDateString()}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
