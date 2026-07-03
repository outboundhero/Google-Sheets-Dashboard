"use client";

// MRL Pacing — dedicated tab (v2 spec).
//
// Catches clients off-pace to hit their minimum MRL threshold for the
// current billing cycle, before the cycle ends. Business-day pacing,
// max-recent-velocity recoverability, ordered root-cause diagnostics with
// derived confidence, fully self-resolving severity (no manual state).
//
// Layout: tier summary cards (click to jump/toggle) → three collapsible
// sections — Critical (default open) · At Risk (collapsed) · On Track
// (collapsed, audit only). Rows are one compact line, expandable to the
// full diagnostic breakdown. Recomputed daily at 8:00 AM PT by
// /api/cron/mrl-pace-check (also posts the Slack Critical digest).

import { useState } from "react";
import Link from "next/link";
import {
  ChevronDown,
  ChevronRight,
  Gauge,
  TrendingUp,
  TrendingDown,
  Minus,
  CalendarClock,
  Boxes,
  PlugZap,
  Send,
  AlertTriangle,
} from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useMrlPace, type MrlPaceClient } from "@/lib/hooks/use-mrl-pace";

type Tier = "critical" | "at_risk" | "on_track";

const TIER_META: Record<Tier, {
  label: string;
  blurb: string;
  pill: string;
  dot: string;
  row: string;
  pct: string;
  card: string;
  cardActive: string;
  number: string;
}> = {
  critical: {
    label: "Critical",
    blurb: "Behind pace and unrecoverable at best recent velocity",
    pill: "bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/40",
    dot: "bg-red-500",
    row: "border-red-200/80 dark:border-red-500/20 bg-red-50/50 dark:bg-red-950/15 hover:bg-red-100/60 dark:hover:bg-red-950/30",
    pct: "text-red-600 dark:text-red-400",
    card: "border-red-200 dark:border-red-500/25 hover:border-red-400 dark:hover:border-red-500/60",
    cardActive: "border-red-400 dark:border-red-500/70 bg-red-50/60 dark:bg-red-950/20",
    number: "text-red-600 dark:text-red-400",
  },
  at_risk: {
    label: "At Risk",
    blurb: "10–30% behind pace, still recoverable",
    pill: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/40",
    dot: "bg-amber-500",
    row: "border-amber-200/80 dark:border-amber-500/20 bg-amber-50/50 dark:bg-amber-950/15 hover:bg-amber-100/60 dark:hover:bg-amber-950/30",
    pct: "text-amber-600 dark:text-amber-400",
    card: "border-amber-200 dark:border-amber-500/25 hover:border-amber-400 dark:hover:border-amber-500/60",
    cardActive: "border-amber-400 dark:border-amber-500/70 bg-amber-50/60 dark:bg-amber-950/20",
    number: "text-amber-600 dark:text-amber-400",
  },
  on_track: {
    label: "On Track",
    blurb: "At or within 10% of expected pace",
    pill: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/40",
    dot: "bg-emerald-500",
    row: "border-emerald-200/70 dark:border-emerald-500/15 bg-emerald-50/40 dark:bg-emerald-950/10 hover:bg-emerald-100/50 dark:hover:bg-emerald-950/25",
    pct: "text-emerald-600 dark:text-emerald-400",
    card: "border-emerald-200 dark:border-emerald-500/25 hover:border-emerald-400 dark:hover:border-emerald-500/60",
    cardActive: "border-emerald-400 dark:border-emerald-500/70 bg-emerald-50/60 dark:bg-emerald-950/20",
    number: "text-emerald-600 dark:text-emerald-400",
  },
};

const ROOT_CAUSE_SHORT: Record<string, string> = {
  insufficient_contact_volume: "Low contact volume",
  low_sending_capacity: "Low sending capacity",
  nurture_routing_gap: "Nurture routing gap",
  failed_campaigns: "Failed campaigns",
  low_conversion: "Leads flowing, low conversion",
};

// ── Sparkline — 7 daily bars, colored by trend ───────────────────────────
function Sparkline({ daily }: { daily: number[] }) {
  if (!daily.length) return null;
  const max = Math.max(1, ...daily);
  const head = daily.slice(0, 4).reduce((a, b) => a + b, 0) / 4;
  const tail = daily.slice(4).reduce((a, b) => a + b, 0) / 3;
  const trend = tail > head ? "up" : tail < head ? "down" : "flat";
  const barCls =
    trend === "up"
      ? "bg-emerald-500 dark:bg-emerald-400"
      : trend === "down"
        ? "bg-red-400 dark:bg-red-400"
        : "bg-zinc-400 dark:bg-zinc-500";
  const TrendIcon = trend === "up" ? TrendingUp : trend === "down" ? TrendingDown : Minus;
  const iconCls =
    trend === "up"
      ? "text-emerald-500 dark:text-emerald-400"
      : trend === "down"
        ? "text-red-500 dark:text-red-400"
        : "text-zinc-400 dark:text-zinc-500";
  return (
    <span
      className="flex items-end gap-[2px] h-4 shrink-0"
      title={`Last 7 days: ${daily.join(", ")} MRLs/day`}
    >
      {daily.map((v, i) => (
        <span
          key={i}
          className={`w-[3px] rounded-sm ${v === 0 ? "bg-zinc-300 dark:bg-zinc-700" : barCls}`}
          style={{ height: `${Math.max(15, (v / max) * 100)}%` }}
        />
      ))}
      <TrendIcon className={`h-3 w-3 ml-1 self-center ${iconCls}`} />
    </span>
  );
}

// ── One client row: compact line → expandable diagnostics ────────────────
function ClientRow({ c }: { c: MrlPaceClient }) {
  const [expanded, setExpanded] = useState(false);
  const meta = TIER_META[c.severity];
  const behindPct = Math.round(c.pctBehind * 100);
  const projOk = c.projectedTotal >= c.threshold;

  return (
    <div className={`rounded-lg border transition-colors ${meta.row}`}>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-3 px-3.5 py-2.5 text-left flex-wrap"
      >
        {expanded
          ? <ChevronDown className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
          : <ChevronRight className="h-3.5 w-3.5 text-zinc-400 shrink-0" />}

        <Link
          href={`/clients/${encodeURIComponent(c.clientTag)}`}
          onClick={(e) => e.stopPropagation()}
          className="font-semibold text-sm text-zinc-900 dark:text-zinc-100 hover:underline shrink-0 min-w-[64px]"
        >
          {c.clientTag}
        </Link>

        <span className="text-xs text-zinc-700 dark:text-zinc-300 tabular-nums shrink-0">
          <span className="font-semibold">{c.actualMrls}</span>
          <span className="text-zinc-400 dark:text-zinc-500"> / {Math.round(c.expectedMrlsToDate)} expected</span>
        </span>

        <span className={`text-xs font-semibold tabular-nums shrink-0 ${meta.pct}`}>
          {behindPct > 0 ? `−${behindPct}%` : "on pace"}
        </span>

        <span className={`text-xs tabular-nums shrink-0 ${projOk ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-600 dark:text-zinc-400"}`}>
          proj {c.projectedTotal}<span className="text-zinc-400 dark:text-zinc-500">/{c.threshold}</span>
        </span>

        {c.rootCauseDetail && (
          <span
            className="text-[10px] font-medium rounded-md bg-zinc-900/5 dark:bg-zinc-100/10 border border-zinc-300/60 dark:border-zinc-600/50 px-1.5 py-0.5 text-zinc-700 dark:text-zinc-300 truncate max-w-[210px]"
            title={c.rootCauseDetail}
          >
            {ROOT_CAUSE_SHORT[c.rootCauseTag] ?? c.rootCauseTag}
            {c.rootCauseConfidence && (
              <span className={c.rootCauseConfidence === "high" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}>
                {" "}· {c.rootCauseConfidence === "high" ? "High" : "Med"}
              </span>
            )}
          </span>
        )}

        <span className="ml-auto flex items-center gap-3 shrink-0">
          {(c.isFirstCycle || c.historicallyRecovers) && (
            <span className="text-[10px] italic text-zinc-500 dark:text-zinc-400">
              {c.isFirstCycle ? "first cycle — expected ramp" : "historically recovers"}
            </span>
          )}
          <span className="text-[11px] text-zinc-500 dark:text-zinc-400 tabular-nums">
            {c.bizDaysRemaining} biz days left
            {c.dayNCritical
              ? ` · Day ${c.dayNCritical} Critical`
              : c.daysInSeverity && c.severity !== "on_track"
                ? ` · day ${c.daysInSeverity} in tier`
                : ""}
          </span>
          <Sparkline daily={c.velocityDaily} />
        </span>
      </button>

      {expanded && (
        <div className="mx-3.5 mb-3 mt-0.5 rounded-md bg-white/60 dark:bg-zinc-900/40 border border-zinc-200/70 dark:border-zinc-700/40 px-4 py-3">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-8 gap-y-2 text-[11.5px] text-zinc-600 dark:text-zinc-400 tabular-nums">
            <div className="col-span-2 lg:col-span-4 text-zinc-800 dark:text-zinc-200 font-medium text-xs">
              {c.companyName}{c.plan ? <span className="text-zinc-400 dark:text-zinc-500 font-normal"> · {c.plan}</span> : ""}
            </div>
            <span className="flex items-center gap-1.5">
              <CalendarClock className="h-3 w-3 text-zinc-400" />
              cycle {c.cycleStart} → {c.cycleEnd}
            </span>
            <span>business day <strong className="text-zinc-800 dark:text-zinc-200">{c.bizDaysElapsed}</strong> of {c.bizDaysTotal}</span>
            <span>velocity <strong className="text-zinc-800 dark:text-zinc-200">{c.velocity7d}</strong>/biz day</span>
            <span>best recent <strong className="text-zinc-800 dark:text-zinc-200">{c.maxVelocity7d}</strong>/biz day</span>
            <span className="flex items-center gap-1.5">
              <Boxes className="h-3 w-3 text-zinc-400" />
              contacts loaded <strong className="text-zinc-800 dark:text-zinc-200">{c.signals.totalContacts.toLocaleString()}</strong>
            </span>
            <span className="flex items-center gap-1.5">
              <PlugZap className="h-3 w-3 text-zinc-400" />
              accounts <strong className="text-emerald-600 dark:text-emerald-400">{c.signals.healthyAccounts}</strong>/{c.signals.totalAccounts} healthy
            </span>
            <span className="flex items-center gap-1.5">
              <Send className="h-3 w-3 text-zinc-400" />
              pipeline <strong className="text-zinc-800 dark:text-zinc-200">{c.signals.leadsInPipeline.toLocaleString()}</strong> leads
            </span>
            <span>nurture campaigns <strong className="text-zinc-800 dark:text-zinc-200">{c.signals.nurtureCampaigns}</strong></span>
            <span className={c.signals.failedCampaigns > 0 ? "text-red-600 dark:text-red-400 flex items-center gap-1.5" : "flex items-center gap-1.5"}>
              {c.signals.failedCampaigns > 0 && <AlertTriangle className="h-3 w-3" />}
              failed campaigns <strong>{c.signals.failedCampaigns}</strong>
            </span>
            {c.priorCycleActualAtSameDay !== null && (
              <span>
                last cycle by day {c.daysElapsed}: <strong className="text-zinc-800 dark:text-zinc-200">{c.priorCycleActualAtSameDay}</strong>
                {c.priorCycleTotal !== null && <span className="text-zinc-400 dark:text-zinc-500"> (finished {c.priorCycleTotal})</span>}
              </span>
            )}
          </div>
          {c.rootCauseDetail && (
            <div className="mt-2.5 pt-2.5 border-t border-zinc-200/70 dark:border-zinc-700/40 text-xs text-zinc-700 dark:text-zinc-300">
              <span className="font-medium">Likely cause:</span> {c.rootCauseDetail}
              {c.rootCauseConfidence && (
                <span className="text-zinc-400 dark:text-zinc-500"> — {c.rootCauseConfidence === "high" ? "High" : "Medium"} confidence</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Collapsible tier section ─────────────────────────────────────────────
function TierSection({
  tier,
  clients,
  open,
  onToggle,
}: {
  tier: Tier;
  clients: MrlPaceClient[];
  open: boolean;
  onToggle: () => void;
}) {
  const meta = TIER_META[tier];
  return (
    <div id={`tier-${tier}`}>
      <button onClick={onToggle} className="w-full flex items-center gap-2 py-2 text-left group">
        {open
          ? <ChevronDown className="h-4 w-4 text-zinc-400 shrink-0" />
          : <ChevronRight className="h-4 w-4 text-zinc-400 shrink-0" />}
        <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide rounded-full px-2.5 py-1 ${meta.pill}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
          {meta.label} — {clients.length}
        </span>
        <span className="text-[11px] text-zinc-400 dark:text-zinc-500 opacity-0 group-hover:opacity-100 transition-opacity">
          {meta.blurb}
        </span>
      </button>
      {open && (
        clients.length === 0 ? (
          <p className="text-xs text-zinc-500 dark:text-zinc-400 pl-6 pb-2">No clients in this tier.</p>
        ) : (
          <div className="flex flex-col gap-1.5 mt-0.5 mb-2">
            {clients.map((c) => <ClientRow key={c.clientTag} c={c} />)}
          </div>
        )
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────
export default function MrlPacingPage() {
  const { clients, evaluatedAt, isLoading } = useMrlPace();
  const [openTiers, setOpenTiers] = useState<Record<Tier, boolean>>({
    critical: true,
    at_risk: false,
    on_track: false,
  });

  const byTier: Record<Tier, MrlPaceClient[]> = {
    critical: clients.filter((c) => c.severity === "critical"),
    at_risk: clients.filter((c) => c.severity === "at_risk"),
    on_track: clients.filter((c) => c.severity === "on_track"),
  };

  const toggle = (t: Tier) => setOpenTiers((p) => ({ ...p, [t]: !p[t] }));
  const openAndScroll = (t: Tier) => {
    setOpenTiers((p) => ({ ...p, [t]: true }));
    // Let the section render before scrolling to it.
    setTimeout(() => document.getElementById(`tier-${t}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="MRL Pacing"
        description="Clients off-pace for their minimum MRL threshold this billing cycle — business-day pace, self-resolving"
      >
        {evaluatedAt && (
          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Gauge className="h-3.5 w-3.5" />
            evaluated {new Date(evaluatedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </PageHeader>

      {isLoading ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Skeleton className="h-28 rounded-xl" />
            <Skeleton className="h-28 rounded-xl" />
            <Skeleton className="h-28 rounded-xl" />
          </div>
          <Skeleton className="h-48 rounded-xl" />
        </div>
      ) : clients.length === 0 ? (
        <div className="rounded-xl border bg-muted/30 px-6 py-12 text-center">
          <Gauge className="h-8 w-8 text-muted-foreground/50 mx-auto mb-3" />
          <p className="text-sm font-medium">No pacing data yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            The pacing job runs daily at 8:00 AM PT. Clients appear here once their billing cycle passes the 7-day grace period.
          </p>
        </div>
      ) : (
        <>
          {/* Tier summary cards — click to open + jump to that section */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {(["critical", "at_risk", "on_track"] as Tier[]).map((t) => {
              const meta = TIER_META[t];
              const active = openTiers[t];
              return (
                <button
                  key={t}
                  onClick={() => openAndScroll(t)}
                  className={`rounded-xl border-2 px-5 py-4 text-left transition-colors ${active ? meta.cardActive : `${meta.card} bg-card`}`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
                    <span className="text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-300">{meta.label}</span>
                  </div>
                  <div className={`text-4xl font-bold tabular-nums mt-2 ${meta.number}`}>
                    {byTier[t].length}
                  </div>
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-1">{meta.blurb}</p>
                </button>
              );
            })}
          </div>

          {/* Tier sections */}
          <div className="rounded-xl border bg-card px-5 py-3">
            <TierSection tier="critical" clients={byTier.critical} open={openTiers.critical} onToggle={() => toggle("critical")} />
            <TierSection tier="at_risk" clients={byTier.at_risk} open={openTiers.at_risk} onToggle={() => toggle("at_risk")} />
            <TierSection tier="on_track" clients={byTier.on_track} open={openTiers.on_track} onToggle={() => toggle("on_track")} />
          </div>
        </>
      )}
    </div>
  );
}
