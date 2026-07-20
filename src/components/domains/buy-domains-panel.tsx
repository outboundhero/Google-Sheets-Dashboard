"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Globe,
  Sparkles,
  Search,
  X,
  CheckCircle2,
  Loader2,
  AlertTriangle,
  XCircle,
  Pause,
  Play,
  Check,
  RefreshCw,
  Trash2,
  ListPlus,
  Clock,
  ShoppingCart,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { useDomains, type DiscoveredDomain } from "@/lib/hooks/use-domains";
import { useBuyQueue, type BuyQueueRow } from "@/lib/hooks/use-buy-queue";

const TICK_MS = 10_500;
const TLDS = [".info", ".com", ".co", ".net", ".org"] as const;
type Tld = (typeof TLDS)[number];

type DiscoveryStatus = "idle" | "running" | "paused" | "complete" | "error";

interface RecentResult {
  domain: string;
  outcome: "available" | "taken" | "error";
  price?: number;
  error?: string;
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatCountdown(iso: string | null): string {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "now";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function BuyDomainsPanel() {
  const { role } = useAuth();
  const isAdmin = role === "admin";

  // Generation controls
  const [mode, setMode] = useState<"niche" | "lookalike">("niche");
  const [niche, setNiche] = useState("commercial cleaning");
  const [seedDomain, setSeedDomain] = useState("");
  const [selectedTlds, setSelectedTlds] = useState<Set<Tld>>(new Set([".info"]));
  const [count, setCount] = useState(80);

  // Discovery state
  const [candidates, setCandidates] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [discoveryStatus, setDiscoveryStatus] = useState<DiscoveryStatus>("idle");
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [skippedAlreadyChecked, setSkippedAlreadyChecked] = useState(0);
  const [recentResults, setRecentResults] = useState<RecentResult[]>([]);
  const [counts, setCounts] = useState({ available: 0, taken: 0, errors: 0 });
  const [generating, setGenerating] = useState(false);
  const tickAbortRef = useRef<{ cancelled: boolean }>({ cancelled: false });

  // Available list + selection
  const isDiscoveryActive = discoveryStatus === "running";
  const { domains, mutate: mutateDomains } = useDomains(isDiscoveryActive ? 8000 : 0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  // Queue
  const { counts: queueCounts, nextEligibleAt, inWindow, recent: queueRecent, mutate: mutateQueue } = useBuyQueue(12000);
  const [enqueuing, setEnqueuing] = useState(false);
  const [enqueueMsg, setEnqueueMsg] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const toggleTld = (t: Tld) => {
    setSelectedTlds((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      if (next.size === 0) next.add(".info");
      return next;
    });
  };

  // ─── Discovery loop ───────────────────────────────────────────────────────
  useEffect(() => {
    if (discoveryStatus !== "running") return;
    if (cursor >= candidates.length) {
      setDiscoveryStatus("complete");
      mutateDomains();
      return;
    }

    const abortRef = tickAbortRef.current;
    abortRef.cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const runOne = async () => {
      const domain = candidates[cursor];
      const t0 = Date.now();
      let outcome: RecentResult["outcome"] = "error";
      let price: number | undefined;
      let err: string | undefined;
      try {
        const res = await fetch("/api/domains/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domain, niche: mode === "lookalike" ? `look-a-like: ${seedDomain}` : niche }),
        });
        const data = await res.json();
        if (abortRef.cancelled) return;
        if (!res.ok) {
          err = data?.error || `HTTP ${res.status}`;
          outcome = "error";
        } else if (!data.available) {
          outcome = "taken";
        } else {
          outcome = "available";
          price = data.price;
        }
      } catch (e) {
        if (abortRef.cancelled) return;
        err = e instanceof Error ? e.message : "Network error";
        outcome = "error";
      }

      setRecentResults((prev) => [{ domain, outcome, price, error: err }, ...prev].slice(0, 12));
      setCounts((c) => ({
        available: c.available + (outcome === "available" ? 1 : 0),
        taken: c.taken + (outcome === "taken" ? 1 : 0),
        errors: c.errors + (outcome === "error" ? 1 : 0),
      }));
      if (outcome === "available") mutateDomains();

      if (abortRef.cancelled) return;
      const elapsed = Date.now() - t0;
      const wait = Math.max(0, TICK_MS - elapsed);
      timer = setTimeout(() => {
        if (!abortRef.cancelled) setCursor((c) => c + 1);
      }, wait);
    };

    runOne();
    return () => {
      abortRef.cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [discoveryStatus, cursor, candidates, mutateDomains, mode, niche, seedDomain]);

  const startDiscovery = useCallback(async () => {
    setDiscoveryError(null);
    setGenerating(true);
    try {
      const res = await fetch("/api/domains/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          tlds: Array.from(selectedTlds),
          niche,
          seedDomain,
          count,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      const fresh: string[] = Array.isArray(data.candidates) ? data.candidates : [];
      setCandidates(fresh);
      setCursor(0);
      setRecentResults([]);
      setCounts({ available: 0, taken: 0, errors: 0 });
      setSkippedAlreadyChecked(typeof data.skippedAlreadyChecked === "number" ? data.skippedAlreadyChecked : 0);
      setDiscoveryStatus(fresh.length === 0 ? "complete" : "running");
    } catch (e) {
      setDiscoveryError(e instanceof Error ? e.message : "Failed to generate candidates");
      setDiscoveryStatus("error");
    } finally {
      setGenerating(false);
    }
  }, [mode, selectedTlds, niche, seedDomain, count]);

  const pauseDiscovery = useCallback(() => {
    tickAbortRef.current.cancelled = true;
    setDiscoveryStatus("paused");
  }, []);
  const resumeDiscovery = useCallback(() => setDiscoveryStatus("running"), []);

  // ─── Available list ────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    if (!search.trim()) return domains;
    const q = search.trim().toLowerCase();
    return domains.filter((d) => d.domain.toLowerCase().includes(q));
  }, [domains, search]);

  const allSelected = filtered.length > 0 && filtered.every((d) => selected.has(d.domain));
  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(filtered.map((d) => d.domain)));
  };
  const toggleOne = (domain: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });
  };

  // ─── Enqueue to buy queue ────────────────────────────────────────────────
  const enqueueSelected = useCallback(async () => {
    const list = Array.from(selected);
    if (list.length === 0) return;
    setEnqueuing(true);
    setEnqueueMsg(null);
    try {
      const res = await fetch("/api/domains/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domains: list,
          source: mode,
          niche: mode === "lookalike" ? `look-a-like: ${seedDomain}` : niche,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setEnqueueMsg(`Added ${data.enqueued} to buy queue${data.skipped ? ` · ${data.skipped} already queued` : ""}.`);
      setSelected(new Set());
      mutateQueue();
    } catch (e) {
      setEnqueueMsg(e instanceof Error ? e.message : "Failed to enqueue");
    } finally {
      setEnqueuing(false);
    }
  }, [selected, mode, niche, seedDomain, mutateQueue]);

  const deleteSelected = useCallback(async () => {
    const list = Array.from(selected);
    if (list.length === 0) return;
    if (!confirm(`Remove ${list.length} domain${list.length !== 1 ? "s" : ""} from the list? They can be re-discovered later.`)) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/domains/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domains: list }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      setSelected(new Set());
      await mutateDomains();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  }, [selected, mutateDomains]);

  const total = candidates.length;
  const checkedSoFar = cursor;
  const progressPct = total > 0 ? Math.min(100, (checkedSoFar / total) * 100) : 0;
  const remainingMin = Math.ceil(((total - checkedSoFar) * TICK_MS) / 60000);

  const queued = queueCounts.queued ?? 0;
  const buying = queueCounts.buying ?? 0;
  const registered = queueCounts.registered ?? 0;
  const failed = queueCounts.failed ?? 0;
  const skipped = queueCounts.skipped ?? 0;
  const hasQueueActivity = queued + buying + registered + failed + skipped > 0;

  return (
    <div className="space-y-6">
      {/* Generation controls */}
      <div className="rounded-xl border bg-card p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-primary/10 p-2.5">
              <Sparkles className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h2 className="text-base font-semibold tracking-tight">Find Domains</h2>
              <p className="text-xs text-muted-foreground">
                Buys on the <span className="font-medium text-foreground">outboundhero</span> Porkbun account · live prices · no cap
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {discoveryStatus === "running" && (
              <Button variant="outline" size="sm" onClick={pauseDiscovery} className="gap-1.5">
                <Pause className="h-3.5 w-3.5" /> Pause
              </Button>
            )}
            {discoveryStatus === "paused" && (
              <Button variant="outline" size="sm" onClick={resumeDiscovery} className="gap-1.5">
                <Play className="h-3.5 w-3.5" /> Resume
              </Button>
            )}
            {isAdmin && (
              <Button size="sm" onClick={startDiscovery} disabled={generating || discoveryStatus === "running"} className="gap-1.5">
                {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                {total > 0 ? "Find more" : "Find domains"}
              </Button>
            )}
          </div>
        </div>

        {isAdmin && (
          <div className="space-y-3 border-t pt-4">
            {/* Mode toggle */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground w-16">Mode</span>
              <ToggleBtn active={mode === "niche"} onClick={() => setMode("niche")}>Commercial cleaning</ToggleBtn>
              <ToggleBtn active={mode === "lookalike"} onClick={() => setMode("lookalike")}>Look-a-like domain</ToggleBtn>
            </div>

            {mode === "niche" ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground w-16">Niche</span>
                <input
                  value={niche}
                  onChange={(e) => setNiche(e.target.value)}
                  className="flex-1 min-w-[200px] text-sm rounded-lg border bg-background px-3 py-1.5 outline-none focus:ring-1 focus:ring-primary"
                  placeholder="commercial cleaning"
                />
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground w-16">Seed</span>
                <input
                  value={seedDomain}
                  onChange={(e) => setSeedDomain(e.target.value)}
                  className="flex-1 min-w-[200px] text-sm rounded-lg border bg-background px-3 py-1.5 outline-none focus:ring-1 focus:ring-primary"
                  placeholder="e.g. dm4pm.com — we'll find look-a-likes"
                />
              </div>
            )}

            {/* TLD multi-select */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground w-16">Endings</span>
              {TLDS.map((t) => (
                <ToggleBtn key={t} active={selectedTlds.has(t)} onClick={() => toggleTld(t)}>{t}</ToggleBtn>
              ))}
            </div>

            {/* Count */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground w-16">Generate</span>
              <input
                type="number"
                min={10}
                max={150}
                value={count}
                onChange={(e) => setCount(Math.max(10, Math.min(150, Number(e.target.value) || 80)))}
                className="w-24 text-sm rounded-lg border bg-background px-3 py-1.5 outline-none focus:ring-1 focus:ring-primary tabular-nums"
              />
              <span className="text-xs text-muted-foreground">names, then checks each live (~10s each)</span>
            </div>
          </div>
        )}

        {discoveryError && (
          <div className="text-sm text-destructive border border-destructive/30 bg-destructive/5 rounded-lg px-3 py-2">
            {discoveryError}
          </div>
        )}

        {(discoveryStatus !== "idle" || total > 0) && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <Stat label="Checked" value={`${checkedSoFar} / ${total}`} />
              <Stat label="Available" value={counts.available} accent="violet" />
              <Stat label="Taken" value={counts.taken} />
              <Stat label="Errors" value={counts.errors} accent={counts.errors > 0 ? "red" : undefined} />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>
                  {discoveryStatus === "running" && `Checking · ~${remainingMin} min remaining`}
                  {discoveryStatus === "paused" && "Paused"}
                  {discoveryStatus === "complete" && total > 0 && "Run complete"}
                  {skippedAlreadyChecked > 0 && discoveryStatus !== "idle" && (
                    <span className="ml-2">· {skippedAlreadyChecked} already checked previously</span>
                  )}
                </span>
                <span className="tabular-nums">{progressPct.toFixed(0)}%</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div className="h-full bg-primary transition-all duration-500 ease-out" style={{ width: `${progressPct}%` }} />
              </div>
            </div>

            {discoveryStatus === "running" && cursor < total && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />
                <span className="truncate">Checking <span className="font-medium text-foreground">{candidates[cursor]}</span></span>
              </div>
            )}

            {recentResults.length > 0 && (
              <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
                {recentResults.map((r, i) => <ResultRow key={`${r.domain}-${i}`} result={r} />)}
              </div>
            )}
          </>
        )}
      </div>

      {/* Buy queue panel */}
      {hasQueueActivity && (
        <div className="rounded-xl border bg-card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShoppingCart className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold">Buy queue</h3>
              <span className="text-[11px] text-muted-foreground">max 20 domains / 8 hours · bought automatically on the server</span>
            </div>
            {inWindow && nextEligibleAt && (
              <span className="flex items-center gap-1.5 text-[11px] text-amber-500">
                <Clock className="h-3.5 w-3.5" /> next batch in {formatCountdown(nextEligibleAt)}
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
            <Stat label="Queued" value={queued} accent={queued > 0 ? "violet" : undefined} />
            <Stat label="Buying" value={buying} />
            <Stat label="Registered" value={registered} accent="emerald" />
            <Stat label="Skipped" value={skipped} />
            <Stat label="Failed" value={failed} accent={failed > 0 ? "red" : undefined} />
          </div>
          {queueRecent.length > 0 && (
            <div className="space-y-1 max-h-64 overflow-y-auto pt-2 border-t">
              {queueRecent.map((r) => <QueueRow key={r.domain} r={r} />)}
            </div>
          )}
        </div>
      )}

      {/* Available domains list */}
      <div className="rounded-xl border bg-card">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Available domains</h2>
            <span className="text-xs text-muted-foreground">{domains.length} ready to buy</span>
          </div>
          <div className="flex items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 w-64">
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search domains…"
              className="flex-1 text-xs bg-transparent outline-none placeholder:text-muted-foreground"
            />
            {search && (
              <button onClick={() => setSearch("")}>
                <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
              </button>
            )}
          </div>
        </div>

        {enqueueMsg && (
          <div className="px-4 py-2 text-xs text-muted-foreground border-b bg-muted/20">{enqueueMsg}</div>
        )}

        {selected.size > 0 && isAdmin && (
          <div className="sticky top-0 z-30 flex items-center justify-between gap-3 px-4 py-2.5 border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80 shadow-sm">
            <span className="text-xs font-medium">{selected.size} selected</span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSelected(new Set())}>Clear</Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1.5 text-destructive hover:text-destructive border-destructive/30"
                onClick={deleteSelected}
                disabled={deleting || enqueuing}
              >
                {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                Delete
              </Button>
              <Button size="sm" className="h-7 text-xs gap-1.5" onClick={enqueueSelected} disabled={enqueuing || deleting}>
                {enqueuing ? <Loader2 className="h-3 w-3 animate-spin" /> : <ListPlus className="h-3 w-3" />}
                Add {selected.size} to buy queue
              </Button>
            </div>
          </div>
        )}

        {filtered.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-12">
            {domains.length === 0
              ? "No available domains yet — set your options and click Find domains above."
              : "No domains match your search."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] text-muted-foreground border-b">
                  <th className="w-[36px] px-3 py-2.5">
                    <button
                      onClick={toggleAll}
                      className={`h-4 w-4 rounded border flex items-center justify-center transition-colors ${
                        allSelected ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30 hover:border-foreground"
                      }`}
                    >
                      {allSelected && <Check className="h-3 w-3" />}
                    </button>
                  </th>
                  <th className="text-left font-medium px-3 py-2.5">Domain</th>
                  <th className="text-right font-medium px-3 py-2.5 w-[120px]">Price</th>
                  <th className="text-right font-medium px-3 py-2.5 w-[160px]">Renewal</th>
                  <th className="text-right font-medium px-3 py-2.5 w-[140px]">Discovered</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((d) => (
                  <DomainRow
                    key={d.domain}
                    d={d}
                    selected={selected.has(d.domain)}
                    onToggle={() => toggleOne(d.domain)}
                    disabled={!isAdmin || enqueuing}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function ToggleBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
        active ? "bg-primary text-primary-foreground border-primary" : "bg-background hover:bg-muted/50 border-muted-foreground/20"
      }`}
    >
      {children}
    </button>
  );
}

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: "violet" | "amber" | "red" | "emerald" }) {
  const colorClass =
    accent === "violet" ? "text-violet-500"
    : accent === "amber" ? "text-amber-500"
    : accent === "red" ? "text-destructive"
    : accent === "emerald" ? "text-emerald-500"
    : "text-foreground";
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${colorClass}`}>{value}</p>
    </div>
  );
}

function ResultRow({ result }: { result: RecentResult }) {
  const { domain, outcome, price, error } = result;
  return (
    <div className="flex items-center gap-2 text-xs px-2 py-1 rounded hover:bg-muted/30">
      {outcome === "available" && <CheckCircle2 className="h-3 w-3 text-violet-500 shrink-0" />}
      {outcome === "taken" && <XCircle className="h-3 w-3 text-muted-foreground/60 shrink-0" />}
      {outcome === "error" && <AlertTriangle className="h-3 w-3 text-destructive shrink-0" />}
      <span className="font-medium truncate">{domain}</span>
      <span className="ml-auto shrink-0">
        {outcome === "available" && <span className="text-violet-500">${price?.toFixed(2)}</span>}
        {outcome === "taken" && <span className="text-muted-foreground/60">taken</span>}
        {outcome === "error" && <span className="text-destructive truncate max-w-[200px] inline-block">{error}</span>}
      </span>
    </div>
  );
}

function DomainRow({ d, selected, onToggle, disabled }: {
  d: DiscoveredDomain;
  selected: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <tr
      className={`transition-colors ${selected ? "bg-primary/5" : "hover:bg-muted/30"} ${disabled ? "" : "cursor-pointer"}`}
      onClick={() => { if (!disabled) onToggle(); }}
    >
      <td className="px-3 py-2.5">
        <div className={`h-4 w-4 rounded border flex items-center justify-center transition-colors ${
          selected ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30"
        }`}>
          {selected && <Check className="h-3 w-3" />}
        </div>
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="font-medium">{d.domain}</span>
        </div>
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums font-medium text-violet-500">
        ${typeof d.price_usd === "number" ? d.price_usd.toFixed(2) : d.price_usd}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-xs text-muted-foreground">
        {d.regular_price_usd != null ? `$${Number(d.regular_price_usd).toFixed(2)}/yr` : "—"}
      </td>
      <td className="px-3 py-2.5 text-right text-xs text-muted-foreground">
        {formatRelative(d.discovered_at)}
      </td>
    </tr>
  );
}

function QueueRow({ r }: { r: BuyQueueRow }) {
  const price = typeof r.real_price_usd === "number" ? r.real_price_usd : parseFloat(String(r.real_price_usd ?? ""));
  return (
    <div className="flex items-center gap-2 text-xs px-2 py-1.5 rounded hover:bg-muted/30">
      {r.status === "queued" && <div className="h-3 w-3 rounded-full border border-muted-foreground/30 shrink-0" />}
      {r.status === "buying" && <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />}
      {r.status === "registered" && <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />}
      {r.status === "skipped" && <XCircle className="h-3 w-3 text-muted-foreground/60 shrink-0" />}
      {r.status === "failed" && <AlertTriangle className="h-3 w-3 text-destructive shrink-0" />}
      <span className="font-medium truncate">{r.domain}</span>
      <span className="ml-auto shrink-0 flex items-center gap-2">
        {Number.isFinite(price) && price > 0 && <span className="text-muted-foreground tabular-nums">${price.toFixed(2)}</span>}
        <span className={
          r.status === "registered" ? "text-emerald-500"
          : r.status === "failed" ? "text-destructive"
          : r.status === "buying" ? "text-primary"
          : "text-muted-foreground"
        }>{r.status}</span>
        {r.last_error && <span className="text-destructive/70 max-w-[200px] truncate" title={r.last_error}>{r.last_error}</span>}
      </span>
    </div>
  );
}
