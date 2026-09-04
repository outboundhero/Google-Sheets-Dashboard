"use client";

import { useState, useEffect, useRef } from "react";
import { RefreshCw, Loader2, ShieldAlert, Eye, AlertTriangle, CheckCircle2, AlertCircle, Circle, ChevronDown, ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/lib/auth-context";
import { ExecuteDialog } from "@/components/replacement/execute-dialog";
import { ThresholdGroupsEditor } from "@/components/replacement/threshold-groups-editor";
import { GroupPlanCard } from "@/components/replacement/group-plan-card";
import { FlaggedDomainsCard } from "@/components/replacement/flagged-domains-card";
import { ShortfallCard } from "@/components/replacement/shortfall-card";
import { TrueUpCard } from "@/components/replacement/true-up-card";
import { ReassignmentCard } from "@/components/replacement/reassignment-card";
import { WrongInstanceCard } from "@/components/replacement/wrong-instance-card";
import { DailyReportCard } from "@/components/replacement/daily-report-card";
import { RetryCard } from "@/components/replacement/retry-card";
import { PurchasePlanCard } from "@/components/replacement/purchase-plan-card";
import { GoingLiveCard } from "@/components/replacement/going-live-card";
import { WarmupForecastCard } from "@/components/replacement/warmup-forecast-card";
import { PurchaseProposalCard } from "@/components/replacement/purchase-proposal-card";
import { BisonCapacityCard } from "@/components/replacement/bison-capacity-card";
import { runExecution, type ExecuteInputs, type ExecStep } from "@/lib/replacement/execute-runner";
import type { ReplacementSettings, LookbackWindow } from "@/lib/replacement/types";
import { inboxingConnectionFor } from "@/lib/replacement/inboxing-connections";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

interface CampaignRef { id: number; name: string; status: string }

interface PlanItem {
  burntDomain: string;
  instance: string;
  provider: "outlook" | "google" | "mixed" | "unknown";
  clientTag: string | null;
  reasons: string[];
  surbl: boolean | null;
  spamhaus: boolean | null;
  redirectUrl: string | null;
  targetCampaigns: CampaignRef[];
  replacementDomain: string | null;
  replacementFrom?: string | null; // donor instance when ≠ instance (cross-instance pull)
  removeOnly: boolean;
  capCurrent: number;
  capMax: number;
  blockers: string[];
}
interface ClientAuditRow {
  clientTag: string; instance: string;
  total: number; info: number; comco: number; other: number;
  outlook: number; google: number; burnt: number; staying: number; capMax: number;
}
interface PlanResponse {
  generatedFor: string;
  infoMigration: boolean;
  burntCount: number;
  unassignedBurntCount: number;
  items: PlanItem[];
  reserveReadyByInstance: Record<string, { outlook: number; google: number; total: number }>;
  reserveList: {
    instance: string;
    domain: string;
    provider: "outlook" | "google" | "mixed" | "unknown";
    isInfo: boolean;
    blacklisted: boolean;
    ageDays: number;
    pullable: boolean;
  }[];
  clientAudit: ClientAuditRow[];
}

interface ActivityEvent {
  id: number; instance: string | null; domain: string | null; clientTag: string | null;
  eventType: string; detail: string | null; createdAt: string;
}
interface PendingCancellation {
  instance: string; domain: string; clientTag: string | null; provider: string | null;
  reason: string | null; scheduledAt: string; status: string; createdAt: string;
}

// short, unambiguous instance labels (outboundhero vs outboundclean both start "outbound")
const INSTANCE_SHORT: Record<string, string> = {
  outboundhero: "OH·B2B", cleaningoutbound: "CO·B2C", facilityreach: "FR·B2B", outboundclean: "OC·B2C",
};

const WINDOWS: { value: LookbackWindow; label: string }[] = [
  { value: "all", label: "All-time" },
  { value: "10", label: "10-day" },
  { value: "15", label: "15-day" },
  { value: "30", label: "30-day" },
];

// Reserve inventory — a per-instance, collapsible list of every untagged
// domain that has finished warmup (≥ 21 days). Each row shows the provider
// (Outlook / Google / mixed / unknown), the TLD, age, and whether it's
// currently pullable as a replacement (green dot) or inventory-only (gray).
interface ReserveDomainRow {
  instance: string;
  domain: string;
  provider: "outlook" | "google" | "mixed" | "unknown";
  isInfo: boolean;
  blacklisted: boolean;
  ageDays: number;
  pullable: boolean;
}

function ReserveInventorySection({ reserveList }: { reserveList: ReserveDomainRow[] }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "pullable" | "inventory">("all");
  const [search, setSearch] = useState("");

  const byInstance = new Map<string, ReserveDomainRow[]>();
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
    <div className="rounded-lg border">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs font-medium hover:bg-muted/40"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        Reserve inventory
        <span className="text-muted-foreground font-normal">
          — {reserveList.length.toLocaleString("en-US")} untagged domain{reserveList.length === 1 ? "" : "s"} ≥ 21d
          {" ("}
          <b className="text-emerald-500">{reserveList.filter((r) => r.pullable).length.toLocaleString("en-US")}</b> pullable
          {", "}
          <b>{reserveList.filter((r) => !r.pullable).length.toLocaleString("en-US")}</b> inventory-only
          {")"}
        </span>
      </button>

      {open && (
        <div className="border-t p-3 space-y-3">
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
        </div>
      )}
    </div>
  );
}

export default function ReplacementPage() {
  const { role } = useAuth();
  const isAdmin = role === "admin";

  const [settings, setSettings] = useState<ReplacementSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [infoMode, setInfoMode] = useState(false);
  const [execClient, setExecClient] = useState("");      // "clientTag|instance"
  const [execInputs, setExecInputs] = useState<ExecuteInputs | null>(null);
  const [activity, setActivity] = useState<ActivityEvent[] | null>(null);
  const [activityArchive, setActivityArchive] = useState(false);
  const [loadingActivity, setLoadingActivity] = useState(false);
  const [cancellations, setCancellations] = useState<PendingCancellation[] | null>(null);
  const [loadingCancels, setLoadingCancels] = useState(false);
  const [cancelsNow, setCancelsNow] = useState(0); // snapshot of "now" when queue loaded (for countdown)

  // Execution queue — run confirmed clients back-to-back, one at a time.
  type ExecJob = { id: number; clientTag: string; instance: string; inputs: ExecuteInputs; status: "queued" | "running" | "done" | "failed"; steps: ExecStep[] };
  const [jobs, setJobs] = useState<ExecJob[]>([]);
  const jobsRef = useRef<ExecJob[]>([]);
  const jobSeq = useRef(0);
  const processingRef = useRef(false);
  const setJobsBoth = (updater: (prev: ExecJob[]) => ExecJob[]) =>
    setJobs((prev) => { const next = updater(prev); jobsRef.current = next; return next; });

  useEffect(() => {
    if (!isAdmin) return;
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/replacement/settings", { cache: "no-store" });
        const data = await res.json();
        if (!active) return;
        if (res.ok) setSettings(data);
        else setError(data.error || "Failed to load settings");
      } catch { if (active) setError("Failed to load settings"); }
    })();
    return () => { active = false; };
  }, [isAdmin]);

  const save = async () => {
    if (!settings) return;
    setSaving(true); setError(null);
    try {
      const res = await fetch("/api/replacement/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings),
      });
      const data = await res.json();
      if (res.ok) { setSettings(data); setSavedAt(Date.now()); }
      else setError(data.error || "Save failed");
    } catch { setError("Save failed"); }
    setSaving(false);
  };

  const loadActivity = async (archive = false) => {
    setLoadingActivity(true);
    setActivityArchive(archive);
    try {
      // default view = trailing 7 days; archive = everything older (never deleted)
      const qs = archive ? "limit=500&archive=1&days=7" : "limit=300&days=7";
      const res = await fetch(`/api/replacement/events?${qs}`, { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setActivity(data.events || []);
    } catch { /* ignore */ }
    setLoadingActivity(false);
  };

  const loadCancellations = async () => {
    setLoadingCancels(true);
    try {
      const res = await fetch("/api/replacement/cancellations?status=pending", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) { setCancellations(data.cancellations || []); setCancelsNow(Date.now()); }
    } catch { /* ignore */ }
    setLoadingCancels(false);
  };

  // Process the queue sequentially. No-ops if already running; the loop picks up
  // any newly-queued jobs added while a prior one was executing.
  const processQueue = async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    try {
      while (true) {
        const next = jobsRef.current.find((j) => j.status === "queued");
        if (!next) break;
        setJobsBoth((prev) => prev.map((j) => (j.id === next.id ? { ...j, status: "running" } : j)));
        const { ok } = await runExecution(next.inputs, (steps) =>
          setJobsBoth((prev) => prev.map((j) => (j.id === next.id ? { ...j, steps } : j))),
        );
        setJobsBoth((prev) => prev.map((j) => (j.id === next.id ? { ...j, status: ok ? "done" : "failed" } : j)));
        // refresh data after each client finishes so executed domains drop off
        loadPlan(infoMode); loadActivity(); loadCancellations();
      }
    } finally { processingRef.current = false; }
  };

  const enqueueJob = (inputs: ExecuteInputs) => {
    const id = ++jobSeq.current;
    setJobsBoth((prev) => [...prev, { id, clientTag: inputs.clientTag, instance: inputs.instance, inputs, status: "queued", steps: [] }]);
    processQueue();
  };

  const loadPlan = async (info: boolean) => {
    setLoadingPlan(true); setError(null);
    try {
      const res = await fetch(`/api/replacement/plan?infoMigration=${info ? 1 : 0}`, { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setPlan(data);
      else setError(data.error || "Plan failed");
    } catch { setError("Plan failed"); }
    setLoadingPlan(false);
  };

  if (!isAdmin) {
    return <div className="p-8 text-sm text-muted-foreground">Admins only.</div>;
  }

  const set = <K extends keyof ReplacementSettings>(k: K, v: ReplacementSettings[K]) =>
    setSettings((s) => (s ? { ...s, [k]: v } : s));

  const numField = (label: string, key: "minReplyRate" | "maxBounceRate" | "minSignals" | "minSent", suffix?: string) => (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1.5">
        <input
          type="number" step="any"
          value={settings?.[key] ?? ""}
          onChange={(e) => set(key, (e.target.value === "" ? null : Number(e.target.value)) as ReplacementSettings[typeof key])}
          className="w-24 text-sm px-2 py-1.5 rounded-lg border bg-background"
        />
        {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
      </div>
    </label>
  );

  return (
    <div className="space-y-5">
      <PageHeader title="Domain Replacement" description="Detection guardrails & observe-only preview">
        <Badge variant="outline" className={`gap-1 ${settings?.mode === "observe" ? "border-emerald-500/30 text-emerald-500" : "border-amber-500/30 text-amber-500"}`}>
          {settings?.mode === "observe" ? <Eye className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}
          mode: {settings?.mode ?? "…"}
        </Badge>
      </PageHeader>

      {settings?.mode === "observe" && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-2.5 text-sm text-emerald-600 dark:text-emerald-400">
          <Eye className="h-4 w-4 shrink-0" />
          Observe-only — detection runs but takes no action. Nothing is tagged, moved, removed, or cancelled.
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />{error}
        </div>
      )}

      {/* Failed execution steps with one-click retry. First thing on the page
          (Spencer Aug-13: "push error section to top of Replacement") — a failed
          step is the only thing here that needs acting on today, and it was
          sitting below five cards. Renders nothing when there is nothing to
          retry, so it costs no space on a clean day. */}
      <RetryCard />

      {/* Guardrail settings */}
      <Card>
        <CardContent className="p-5 space-y-4">
          <div className="text-sm font-medium">Guardrails — what makes a domain &ldquo;burnt&rdquo;</div>
          {!settings ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : (
            <>
              <div className="flex flex-wrap gap-5">
                {numField("Reply rate below", "minReplyRate", "%")}
                {numField("Bounce rate above", "maxBounceRate", "%")}
                {numField("Min signals to flag", "minSignals")}
                {numField("Ignore if sent under", "minSent")}
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">Rate window</span>
                  <select
                    value={settings.lookbackWindow}
                    onChange={(e) => set("lookbackWindow", e.target.value as LookbackWindow)}
                    className="text-sm px-2 py-1.5 rounded-lg border bg-background"
                  >
                    {WINDOWS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
                  </select>
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-5">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={settings.flagOnSurbl} onChange={(e) => set("flagOnSurbl", e.target.checked)} />
                  SURBL listed counts as a signal
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={settings.flagOnSpamhaus} onChange={(e) => set("flagOnSpamhaus", e.target.checked)} />
                  Spamhaus DBL listed counts as a signal
                </label>
                <label className="flex items-center gap-2 text-sm" title="Nick + Spencer Aug-10: allow SURBL-listed reserves for now. Clean reserves are always pulled first; Spamhaus-listed are never pulled. Untick once inventory recovers.">
                  <input type="checkbox" checked={settings.allowSurblReserves} onChange={(e) => set("allowSurblReserves", e.target.checked)} />
                  Allow SURBL-listed domains as replacements
                </label>
                <label className="flex items-center gap-2 text-sm" title="Spencer Aug-13: start reusing .info domains. They are pulled last within each pool — only once the better stock is gone — and never while the plan is built in .info-migration mode.">
                  <input type="checkbox" checked={settings.allowInfoReserves} onChange={(e) => set("allowInfoReserves", e.target.checked)} />
                  Allow .info domains as replacements
                </label>
                <label className="flex items-center gap-2 text-sm ml-auto">
                  <span className="text-xs text-muted-foreground">Mode</span>
                  <select
                    value={settings.mode}
                    onChange={(e) => set("mode", e.target.value as ReplacementSettings["mode"])}
                    className="text-sm px-2 py-1.5 rounded-lg border bg-background"
                  >
                    <option value="observe">observe (safe)</option>
                    <option value="confirm">confirm</option>
                    <option value="auto">auto (cron executes plan)</option>
                  </select>
                </label>
              </div>
              <div className="flex items-center gap-3">
                <Button size="sm" onClick={save} disabled={saving} className="gap-2">
                  {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save guardrails
                </Button>
                {savedAt && <span className="text-xs text-emerald-500">Saved</span>}
                <span className="text-[11px] text-muted-foreground">
                  A domain is flagged only when ≥ {settings.minSignals} signals fire at once and it has sent ≥ {settings.minSent}.
                </span>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Segmented threshold groups (per-client-tag) */}
      <ThresholdGroupsEditor />

      {/* Group-driven replacement plan (observe) — same plan, groups decide burnt */}
      <GroupPlanCard />

      {/* Flagged domains — reason-first table w/ drag-select bulk Skip + skipped queue */}
      <FlaggedDomainsCard />

      {/* Tier-aware shortfall — how many domains to add per b2b/b2c instance per tag */}
      <ShortfallCard />

      {/* True-up — fill to cap / trim over cap, and which tags have no reserve left */}
      <TrueUpCard />

      {/* Client → client domain hand-over with the 2-day wind-down (Nick 8/4 doc #5). */}
      <ReassignmentCard />

      {/* Wrong-instance flag + per-client Run (moves domains to the correct instance) */}
      <WrongInstanceCard />

      {/* End-of-day report — what replacement did (audit log, per PST day) */}
      <DailyReportCard />

      <PurchasePlanCard />

      {/* Staged domain buys — approve-first, nothing purchased without a click */}
      <PurchaseProposalCard />

      {/* Sender-account limits per workspace — drives the purchase capacity gate */}
      <BisonCapacityCard />

      {/* When reserve domains finish warm-up (read-only forecast) */}
      <WarmupForecastCard />

      <GoingLiveCard />

      {/* Replacement plan — full proposed action per burnt domain (observe-only) */}
      <Card>
        <CardContent className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Replacement plan — what would happen to each burnt domain</div>
              <div className="text-[11px] text-muted-foreground">Observe-only — pull reserve → tag → set redirect → attach to campaigns → remove burnt. Nothing executes.</div>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input type="checkbox" checked={infoMode} onChange={(e) => setInfoMode(e.target.checked)} />
                Migrate all .info
              </label>
              <Button size="sm" variant="outline" onClick={() => loadPlan(infoMode)} disabled={loadingPlan} className="gap-2">
                <RefreshCw className={`h-4 w-4 ${loadingPlan ? "animate-spin" : ""}`} />
                {loadingPlan ? "Building…" : "Build plan"}
              </Button>
            </div>
          </div>

          {plan && (
            <>
              <div className="flex flex-wrap gap-4 text-sm">
                {plan.infoMigration && <Badge variant="outline" className="border-amber-500/30 text-amber-500">.info migration mode</Badge>}
                <span className="text-muted-foreground">{plan.infoMigration ? "To remove" : "Burnt (assigned)"} <b className="text-amber-500">{plan.burntCount.toLocaleString()}</b></span>
                <span className="text-muted-foreground">Get replacement <b className="text-emerald-500">{plan.items.filter((i) => !i.removeOnly).length.toLocaleString()}</b></span>
                <span className="text-muted-foreground">Remove-only (at cap) <b>{plan.items.filter((i) => i.removeOnly).length.toLocaleString()}</b></span>
                <span className="text-muted-foreground">Of removed: <b className="text-red-400">{plan.items.filter((i) => i.surbl === true || i.spamhaus === true).length.toLocaleString()}</b> blacklisted · <b>{plan.items.filter((i) => !(i.surbl === true || i.spamhaus === true)).length.toLocaleString()}</b> clean (migrating)</span>
                {plan.unassignedBurntCount > 0 && (
                  <span className="text-muted-foreground">Burnt spare/no-tag <b className="text-muted-foreground">{plan.unassignedBurntCount.toLocaleString()}</b> <span className="text-[10px]">(clean up, not replaced)</span></span>
                )}
                <span className="text-muted-foreground" title="Outlook / Google = ready to pull as a replacement (pure provider, non-.info, ≥21d, clean). Total = every untagged domain ≥21d, regardless of TLD or provider.">
                  Reserve (pull: Outlook / Google · total ≥21d):
                </span>
                {Object.entries(plan.reserveReadyByInstance).map(([inst, c]) => (
                  <span key={inst} className="text-muted-foreground">
                    {inst}: <b className={c.outlook > 0 ? "text-emerald-500" : "text-destructive"}>{c.outlook}</b>
                    {" / "}<b className={c.google > 0 ? "text-emerald-500" : "text-muted-foreground"}>{c.google}</b>
                    <span className="text-[10px] ml-1">· <b className="text-foreground">{c.total}</b> total</span>
                  </span>
                ))}
              </div>

              {/* Reserve inventory — the actual domain names, per instance.
                  Collapsed by default because the list can be hundreds of rows.
                  Falls back to an empty list if the backend response predates
                  the reserveList field (old cached response). */}
              <ReserveInventorySection reserveList={plan.reserveList ?? []} />

              {isAdmin && (() => {
                const groups = new Map<string, { clientTag: string; instance: string; replace: number; remove: number }>();
                for (const it of plan.items) {
                  if (!it.clientTag) continue;
                  const k = `${it.clientTag}|${it.instance}`;
                  if (!groups.has(k)) groups.set(k, { clientTag: it.clientTag, instance: it.instance, replace: 0, remove: 0 });
                  const g = groups.get(k)!;
                  g.remove++;
                  if (!it.removeOnly && it.blockers.length === 0 && it.replacementDomain) g.replace++;
                }
                const list = [...groups.entries()].sort((a, b) => a[1].clientTag.localeCompare(b[1].clientTag));
                const startExec = () => {
                  const [tag, instance] = execClient.split("|");
                  const items = plan.items.filter((i) => i.clientTag === tag && i.instance === instance);
                  const replItems = items.filter((i) => !i.removeOnly && i.blockers.length === 0 && i.replacementDomain);
                  setExecInputs({
                    clientTag: tag, instance,
                    instancesQuery: `instances=${instance}`,
                    redirectUrl: items.find((i) => i.redirectUrl)?.redirectUrl ?? null,
                    targetCampaigns: (replItems[0]?.targetCampaigns ?? []).map((c) => ({ id: c.id, name: c.name })),
                    replacementDomains: replItems.map((i) => i.replacementDomain!),
                    removeDomains: items.map((i) => i.burntDomain),
                    // Donor reserves living on another instance: the runner moves
                    // them here (verify-all) before tagging; donor copy auto-deletes 24h later.
                    crossMoves: replItems
                      .filter((i) => i.replacementFrom && i.replacementFrom !== instance)
                      .map((i) => ({
                        domain: i.replacementDomain!,
                        fromInstance: i.replacementFrom!,
                        platformConnectionId: inboxingConnectionFor(instance as BisonInstanceSlug),
                      })),
                  });
                };
                return (
                  <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 flex-wrap">
                    <span className="text-xs font-medium">Execute for one client:</span>
                    <select value={execClient} onChange={(e) => setExecClient(e.target.value)} className="text-xs px-2 py-1 rounded border bg-background">
                      <option value="">Select client…</option>
                      {list.map(([k, g]) => <option key={k} value={k}>{g.clientTag} ({INSTANCE_SHORT[g.instance] ?? g.instance}) — {g.replace} replace · {g.remove} remove</option>)}
                    </select>
                    <Button size="sm" disabled={!execClient} onClick={startExec} className="h-7 text-xs">Execute →</Button>
                    <span className="text-[10px] text-muted-foreground ml-auto">Confirm-first · reversible · vendor-delete waits 5 days</span>
                  </div>
                );
              })()}

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
                    <span className={bl ? "text-red-400" : "text-muted-foreground"} title={bl ? `Blacklisted: ${blDetail}` : "Not blacklisted (migrating off .info)"}>
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
            </>
          )}
        </CardContent>
      </Card>

      {/* Execution queue — confirmed clients running back-to-back */}
      {jobs.length > 0 && (
        <Card>
          <CardContent className="p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">Execution queue</div>
              <div className="flex items-center gap-3">
                <span className="text-[11px] text-muted-foreground">
                  {jobs.filter((j) => j.status === "done").length} done · {jobs.filter((j) => j.status === "running").length} running · {jobs.filter((j) => j.status === "queued").length} queued
                  {jobs.some((j) => j.status === "failed") ? ` · ${jobs.filter((j) => j.status === "failed").length} failed` : ""}
                </span>
                {!jobs.some((j) => j.status === "running" || j.status === "queued") && (
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setJobs([]); jobsRef.current = []; }}>Clear</Button>
                )}
              </div>
            </div>
            <div className="space-y-2">
              {jobs.map((job) => (
                <div key={job.id} className="rounded-lg border px-3 py-2">
                  <div className="flex items-center gap-2 text-sm">
                    {job.status === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" />
                      : job.status === "done" ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                      : job.status === "failed" ? <AlertCircle className="h-3.5 w-3.5 text-red-500" />
                      : <Circle className="h-3.5 w-3.5 text-zinc-400" />}
                    <span className="font-medium">{job.clientTag}</span>
                    <span className="text-muted-foreground text-xs">({INSTANCE_SHORT[job.instance] ?? job.instance})</span>
                    <span className="text-xs text-muted-foreground">{job.inputs.replacementDomains.length} add · {job.inputs.removeDomains.length} remove</span>
                    <span className={`text-xs ml-auto capitalize ${job.status === "failed" ? "text-red-500" : job.status === "done" ? "text-emerald-500" : "text-muted-foreground"}`}>{job.status}</span>
                  </div>
                  {(job.status === "running" || job.status === "failed") && job.steps.length > 0 && (
                    <ul className="mt-1.5 space-y-1 text-xs pl-5">
                      {job.steps.map((s) => (
                        <li key={s.key} className={`flex items-center gap-2 ${s.state === "skipped" ? "opacity-60" : ""}`}>
                          {s.state === "running" ? <Loader2 className="h-3 w-3 animate-spin text-amber-500 shrink-0" />
                            : s.state === "done" ? <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
                            : s.state === "failed" ? <AlertCircle className="h-3 w-3 text-red-500 shrink-0" />
                            : s.state === "degraded" ? <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />
                            : <Circle className="h-3 w-3 text-zinc-300 dark:text-zinc-600 shrink-0" />}
                          <span className="flex-1">{s.label}</span>
                          {s.note && <span className={`text-[10px] truncate max-w-[180px] italic ${s.state === "failed" ? "text-red-500" : s.state === "degraded" ? "text-amber-500" : "text-muted-foreground"}`} title={s.note}>{s.note}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Per-client domain-count audit (validates totals / caps) */}
      {plan && plan.clientAudit.length > 0 && (
        <Card>
          <CardContent className="p-5 space-y-3">
            <div className="text-sm font-medium">Per-client domain count — by TLD & provider</div>
            <div className="text-[11px] text-muted-foreground">Sorted by total. `.info` = to migrate off · `.com/.co` = keep. <b>Cap = staying/limit</b> (staying = domains kept after the removals in this run — matches the plan). Red = over the limit (excess healthy left in place, 0 replacements added).</div>
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
          </CardContent>
        </Card>
      )}

      {/* Pending cancellations — the 5-day vendor-delete queue */}
      <Card>
        <CardContent className="p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Pending cancellations — 5-day vendor-delete queue</div>
              <div className="text-[11px] text-muted-foreground">Burnt domains removed from campaigns, awaiting provider cancellation. <b>Fires automatically</b> once the grace elapses — vendor cancel, then Bison sender delete. Per-domain steps land in the history feed below.</div>
            </div>
            <Button size="sm" variant="outline" onClick={loadCancellations} disabled={loadingCancels} className="gap-2">
              <RefreshCw className={`h-4 w-4 ${loadingCancels ? "animate-spin" : ""}`} />
              {loadingCancels ? "Loading…" : "Load queue"}
            </Button>
          </div>
          {cancellations && (
            cancellations.length === 0 ? (
              <p className="text-sm text-muted-foreground">No domains in the cancellation queue.</p>
            ) : (<>
              {(() => {
                const mix: Record<string, number> = {};
                for (const c of cancellations) { const p = c.provider || "unknown"; mix[p] = (mix[p] || 0) + 1; }
                const auto = (mix.inboxing || 0) + (mix.milkbox || 0);
                const sheet = cancellations.length - auto;
                return (
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <span className="text-muted-foreground"><b className="text-amber-500">{cancellations.length.toLocaleString()}</b> pending</span>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-emerald-500"><b>{auto}</b> auto-cancel (API)</span>
                    <span className="text-amber-500"><b>{sheet}</b> → sheet</span>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-[11px] text-muted-foreground">vendor mix: {Object.entries(mix).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} ${n}`).join(" · ")}</span>
                  </div>
                );
              })()}
              <div className="rounded-lg border divide-y max-h-[420px] overflow-y-auto">
                <div className="grid grid-cols-[1fr_85px_85px_95px_100px_1fr] gap-2 px-3 py-2 text-[11px] text-muted-foreground font-medium bg-muted/30 sticky top-0">
                  <span>Domain</span><span>Client</span><span>Instance</span><span>Vendor</span><span>Fires in</span><span>Reason</span>
                </div>
                {cancellations.map((c) => {
                  const ms = new Date(c.scheduledAt).getTime() - cancelsNow;
                  const days = Math.floor(ms / 86_400_000);
                  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
                  const due = ms <= 0;
                  const apiCancel = c.provider === "inboxing" || c.provider === "milkbox"; // auto-cancellable
                  return (
                    <div key={`${c.instance}:${c.domain}`} className="grid grid-cols-[1fr_85px_85px_95px_100px_1fr] gap-2 px-3 py-2 text-xs items-center">
                      <span className="truncate" title={c.domain}>{c.domain}</span>
                      <span className="font-medium">{c.clientTag ?? "—"}</span>
                      <span className="text-muted-foreground">{INSTANCE_SHORT[c.instance] ?? c.instance}</span>
                      <span className={apiCancel ? "text-emerald-500" : c.provider === "unknown" ? "text-muted-foreground" : "text-amber-500"} title={apiCancel ? "auto-cancel via API" : "manual / cancel sheet"}>
                        {c.provider ?? "unknown"}
                      </span>
                      <span className={due ? "text-destructive font-medium" : "text-muted-foreground tabular-nums"}>
                        {due ? "due now" : days > 0 ? `${days}d ${hours}h` : `${hours}h`}
                      </span>
                      <span className="truncate text-muted-foreground" title={c.reason ?? ""}>{c.reason ?? ""}</span>
                    </div>
                  );
                })}
              </div>
            </>)
          )}
        </CardContent>
      </Card>

      {/* Activity log — what the execution actually did */}
      <Card>
        <CardContent className="p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Activity log — what was executed</div>
              <div className="text-[11px] text-muted-foreground">Every real action (tag · redirect · attach · removed · cancellation scheduled), newest first. Default = trailing 7 days; older lives in the archive.</div>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant={activityArchive ? "outline" : "default"} onClick={() => loadActivity(false)} disabled={loadingActivity} className="gap-2">
                <RefreshCw className={`h-4 w-4 ${loadingActivity && !activityArchive ? "animate-spin" : ""}`} />
                Last 7 days
              </Button>
              <Button size="sm" variant={activityArchive ? "default" : "outline"} onClick={() => loadActivity(true)} disabled={loadingActivity} className="gap-2">
                Archive (&gt;7d)
              </Button>
            </div>
          </div>
          {activity && (
            activity.length === 0 ? (
              <p className="text-sm text-muted-foreground">{activityArchive ? "Nothing in the archive (no actions older than 7 days)." : "No actions in the last 7 days."}</p>
            ) : (
              <div className="rounded-lg border divide-y max-h-[420px] overflow-y-auto">
                <div className="grid grid-cols-[140px_90px_1fr_110px_1fr] gap-2 px-3 py-2 text-[11px] text-muted-foreground font-medium bg-muted/30 sticky top-0">
                  <span>When</span><span>Client</span><span>Domain</span><span>Action</span><span>Detail</span>
                </div>
                {activity.map((e) => {
                  const ec = e.eventType === "removed" ? "text-amber-500"
                    : e.eventType === "error" ? "text-destructive"
                    : ["tagged", "redirect_set", "attached"].includes(e.eventType) ? "text-emerald-500" : "text-muted-foreground";
                  return (
                    <div key={e.id} className="grid grid-cols-[140px_90px_1fr_110px_1fr] gap-2 px-3 py-2 text-xs items-start">
                      <span className="text-muted-foreground tabular-nums">{new Date(e.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                      <span className="font-medium">{e.clientTag ?? "—"}</span>
                      <span className="truncate" title={e.domain ?? ""}>{e.domain ?? "—"}</span>
                      <span className={ec}>{e.eventType}</span>
                      <span className="truncate text-muted-foreground" title={e.detail ?? ""}>{e.detail ?? ""}</span>
                    </div>
                  );
                })}
              </div>
            )
          )}
        </CardContent>
      </Card>

      {execInputs && (
        <ExecuteDialog
          open={!!execInputs}
          onOpenChange={(o) => { if (!o) setExecInputs(null); }}
          inputs={execInputs}
          onConfirm={(inp) => { enqueueJob(inp); setExecInputs(null); }}
        />
      )}
    </div>
  );
}
