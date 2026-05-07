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
  DollarSign,
  RefreshCw,
} from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { useDomains, type DiscoveredDomain } from "@/lib/hooks/use-domains";

const TICK_MS = 10_500;
const PRICE_CAP_USD = 4;

type DiscoveryStatus = "idle" | "running" | "paused" | "complete" | "error";

interface RecentResult {
  domain: string;
  outcome: "available" | "taken" | "over_cap" | "error";
  price?: number;
  error?: string;
}

interface PerDomain {
  domain: string;
  status: "pending" | "registering" | "auto_renew" | "done" | "error";
  error?: string;
}

interface RegisterJob {
  perDomain: PerDomain[];
  sheetStatus: "pending" | "running" | "done" | "error" | "skipped";
  sheetError?: string;
  sheetAdded?: number;
  sheetSkipped?: number;
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

export default function DomainsPage() {
  const { role } = useAuth();
  const isAdmin = role === "admin";

  // Discovery state
  const [candidates, setCandidates] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [discoveryStatus, setDiscoveryStatus] = useState<DiscoveryStatus>("idle");
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [skippedAlreadyChecked, setSkippedAlreadyChecked] = useState(0);
  const [recentResults, setRecentResults] = useState<RecentResult[]>([]);
  const [counts, setCounts] = useState({ available: 0, taken: 0, overCap: 0, errors: 0 });
  const [generating, setGenerating] = useState(false);
  const tickAbortRef = useRef<{ cancelled: boolean }>({ cancelled: false });

  // Available list + selection
  const isDiscoveryActive = discoveryStatus === "running";
  const { domains, mutate: mutateDomains } = useDomains(isDiscoveryActive ? 8000 : 0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  // Registration job
  const [registerJob, setRegisterJob] = useState<RegisterJob | null>(null);
  const [registering, setRegistering] = useState(false);

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
          body: JSON.stringify({ domain }),
        });
        const data = await res.json();
        if (abortRef.cancelled) return;
        if (!res.ok) {
          err = data?.error || `HTTP ${res.status}`;
          outcome = "error";
        } else if (!data.available) {
          outcome = "taken";
        } else if (data.price > PRICE_CAP_USD) {
          outcome = "over_cap";
          price = data.price;
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
        overCap: c.overCap + (outcome === "over_cap" ? 1 : 0),
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
  }, [discoveryStatus, cursor, candidates, mutateDomains]);

  const startDiscovery = useCallback(async () => {
    setDiscoveryError(null);
    setGenerating(true);
    try {
      const res = await fetch("/api/domains/generate", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      const fresh: string[] = Array.isArray(data.candidates) ? data.candidates : [];
      setCandidates(fresh);
      setCursor(0);
      setRecentResults([]);
      setCounts({ available: 0, taken: 0, overCap: 0, errors: 0 });
      setSkippedAlreadyChecked(typeof data.skippedAlreadyChecked === "number" ? data.skippedAlreadyChecked : 0);
      if (fresh.length === 0) {
        setDiscoveryStatus("complete");
      } else {
        setDiscoveryStatus("running");
      }
    } catch (e) {
      setDiscoveryError(e instanceof Error ? e.message : "Failed to generate candidates");
      setDiscoveryStatus("error");
    } finally {
      setGenerating(false);
    }
  }, []);

  const pauseDiscovery = useCallback(() => {
    tickAbortRef.current.cancelled = true;
    setDiscoveryStatus("paused");
  }, []);

  const resumeDiscovery = useCallback(() => {
    setDiscoveryStatus("running");
  }, []);

  // ─── Available list filters ────────────────────────────────────────────────
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

  // ─── Registration ──────────────────────────────────────────────────────────
  const startRegistration = useCallback(async () => {
    const list = Array.from(selected);
    if (list.length === 0) return;
    setRegistering(true);
    setRegisterJob({
      perDomain: list.map((d) => ({ domain: d, status: "pending" })),
      sheetStatus: "pending",
    });

    const succeeded: string[] = [];
    for (let i = 0; i < list.length; i++) {
      const domain = list[i];
      setRegisterJob((prev) => prev ? {
        ...prev,
        perDomain: prev.perDomain.map((p, idx) => idx === i ? { ...p, status: "registering" } : p),
      } : prev);
      try {
        const res = await fetch("/api/domains/register-one", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domain }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        if (data.registered) {
          succeeded.push(domain);
          setRegisterJob((prev) => prev ? {
            ...prev,
            perDomain: prev.perDomain.map((p, idx) =>
              idx === i ? { ...p, status: "done", error: data.autoRenewError || undefined } : p
            ),
          } : prev);
        } else {
          throw new Error(data?.error || "Register failed");
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Register failed";
        setRegisterJob((prev) => prev ? {
          ...prev,
          perDomain: prev.perDomain.map((p, idx) => idx === i ? { ...p, status: "error", error: msg } : p),
        } : prev);
      }
    }

    if (succeeded.length === 0) {
      setRegisterJob((prev) => prev ? { ...prev, sheetStatus: "skipped" } : prev);
      setRegistering(false);
      mutateDomains();
      return;
    }

    setRegisterJob((prev) => prev ? { ...prev, sheetStatus: "running" } : prev);
    try {
      const res = await fetch("/api/domains/append-to-sheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domains: succeeded }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setRegisterJob((prev) => prev ? {
        ...prev,
        sheetStatus: "done",
        sheetAdded: data.added || 0,
        sheetSkipped: data.skipped || 0,
      } : prev);
    } catch (e) {
      setRegisterJob((prev) => prev ? {
        ...prev,
        sheetStatus: "error",
        sheetError: e instanceof Error ? e.message : "Sheet append failed",
      } : prev);
    }

    setSelected(new Set());
    setRegistering(false);
    mutateDomains();
  }, [selected, mutateDomains]);

  // ─── Render ────────────────────────────────────────────────────────────────
  const checkedSoFar = cursor + (discoveryStatus === "running" ? 0 : 0);
  const total = candidates.length;
  const progressPct = total > 0 ? Math.min(100, (checkedSoFar / total) * 100) : 0;
  const remainingMin = Math.ceil(((total - checkedSoFar) * TICK_MS) / 60000);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Domains"
        description="Discover available .info domains for commercial cleaning, register cheap ones on Porkbun, append to your secondary-domain sheet."
      />

      {/* Discovery card */}
      <div className="rounded-xl border bg-card p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-primary/10 p-2.5">
              <Sparkles className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h2 className="text-base font-semibold tracking-tight">Find Domains</h2>
              <p className="text-xs text-muted-foreground">commercial cleaning · .info · max ${PRICE_CAP_USD} per domain</p>
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
                {total > 0 ? "Find more" : "Find 80 domains"}
              </Button>
            )}
          </div>
        </div>

        {discoveryError && (
          <div className="text-sm text-destructive border border-destructive/30 bg-destructive/5 rounded-lg px-3 py-2">
            {discoveryError}
          </div>
        )}

        {(discoveryStatus !== "idle" || total > 0) && (
          <>
            {/* Stats row */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
              <Stat label="Checked" value={`${checkedSoFar} / ${total}`} />
              <Stat label="Available · cheap" value={counts.available} accent="violet" />
              <Stat label="Over cap" value={counts.overCap} accent="amber" />
              <Stat label="Taken" value={counts.taken} />
              <Stat label="Errors" value={counts.errors} accent={counts.errors > 0 ? "red" : undefined} />
            </div>

            {/* Progress bar */}
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
                <div
                  className="h-full bg-primary transition-all duration-500 ease-out"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>

            {/* Currently checking */}
            {discoveryStatus === "running" && cursor < total && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />
                <span className="truncate">Checking <span className="font-medium text-foreground">{candidates[cursor]}</span></span>
              </div>
            )}

            {/* Recent results */}
            {recentResults.length > 0 && (
              <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
                {recentResults.map((r, i) => (
                  <ResultRow key={`${r.domain}-${i}`} result={r} />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Available domains list */}
      <div className="rounded-xl border bg-card">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Available domains</h2>
            <span className="text-xs text-muted-foreground">{domains.length} ready to register</span>
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

        {selected.size > 0 && isAdmin && (
          <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b bg-primary/5">
            <span className="text-xs font-medium">{selected.size} selected</span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSelected(new Set())}>Clear</Button>
              <Button size="sm" className="h-7 text-xs gap-1.5" onClick={startRegistration} disabled={registering}>
                {registering ? <Loader2 className="h-3 w-3 animate-spin" /> : <DollarSign className="h-3 w-3" />}
                Register {selected.size} domain{selected.size !== 1 ? "s" : ""}
              </Button>
            </div>
          </div>
        )}

        {filtered.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-12">
            {domains.length === 0
              ? "No available domains yet — click Find 80 domains above to start."
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
                    disabled={!isAdmin || registering}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Registration progress */}
      {registerJob && (
        <div className="rounded-xl border bg-card p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {registering ? (
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
              ) : registerJob.sheetStatus === "done" || registerJob.sheetStatus === "skipped" ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-amber-500" />
              )}
              <h3 className="text-sm font-semibold">{registering ? "Registering domains" : "Registration complete"}</h3>
            </div>
            {!registering && (
              <button onClick={() => setRegisterJob(null)} className="text-[11px] text-muted-foreground hover:text-foreground">
                Dismiss
              </button>
            )}
          </div>

          <div className="space-y-1 max-h-64 overflow-y-auto">
            {registerJob.perDomain.map((p) => (
              <PerDomainRow key={p.domain} p={p} />
            ))}
            {registerJob.sheetStatus !== "skipped" && (
              <div className="flex items-center gap-2 text-xs pt-1 mt-1 border-t">
                {registerJob.sheetStatus === "pending" && <div className="h-3 w-3 rounded-full border border-muted-foreground/30 shrink-0" />}
                {registerJob.sheetStatus === "running" && <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />}
                {registerJob.sheetStatus === "done" && <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />}
                {registerJob.sheetStatus === "error" && <AlertTriangle className="h-3 w-3 text-destructive shrink-0" />}
                <span className="text-muted-foreground">Append to Secondary Domain sheet</span>
                {registerJob.sheetStatus === "done" && (
                  <span className="ml-auto text-emerald-500">
                    +{registerJob.sheetAdded} added
                    {(registerJob.sheetSkipped ?? 0) > 0 && (
                      <span className="text-amber-500"> ({registerJob.sheetSkipped} dup)</span>
                    )}
                  </span>
                )}
                {registerJob.sheetStatus === "error" && (
                  <span className="ml-auto text-destructive truncate">{registerJob.sheetError}</span>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: "violet" | "amber" | "red" }) {
  const colorClass =
    accent === "violet" ? "text-violet-500"
    : accent === "amber" ? "text-amber-500"
    : accent === "red" ? "text-destructive"
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
      {outcome === "over_cap" && <DollarSign className="h-3 w-3 text-amber-500 shrink-0" />}
      {outcome === "error" && <AlertTriangle className="h-3 w-3 text-destructive shrink-0" />}
      <span className="font-medium truncate">{domain}</span>
      <span className="ml-auto shrink-0">
        {outcome === "available" && <span className="text-violet-500">${price?.toFixed(2)}</span>}
        {outcome === "over_cap" && <span className="text-amber-500">${price?.toFixed(2)} over cap</span>}
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
        <div
          className={`h-4 w-4 rounded border flex items-center justify-center transition-colors ${
            selected ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30"
          }`}
        >
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

function PerDomainRow({ p }: { p: PerDomain }) {
  return (
    <div className="flex items-center gap-2 text-xs px-2 py-1.5 rounded hover:bg-muted/30">
      {p.status === "pending" && <div className="h-3 w-3 rounded-full border border-muted-foreground/30 shrink-0" />}
      {p.status === "registering" && <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />}
      {p.status === "auto_renew" && <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />}
      {p.status === "done" && <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />}
      {p.status === "error" && <AlertTriangle className="h-3 w-3 text-destructive shrink-0" />}
      <span className="font-medium truncate">{p.domain}</span>
      <span className="ml-auto shrink-0 text-[10px]">
        {p.status === "registering" && <span className="text-primary">registering…</span>}
        {p.status === "auto_renew" && <span className="text-primary">disabling auto-renew…</span>}
        {p.status === "done" && (
          <span className="text-emerald-500">
            registered {p.error && <span className="text-amber-500">· auto-renew warn</span>}
          </span>
        )}
        {p.status === "error" && <span className="text-destructive max-w-[260px] inline-block truncate">{p.error}</span>}
      </span>
    </div>
  );
}
