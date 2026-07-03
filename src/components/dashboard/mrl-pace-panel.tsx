"use client";

// "Clients off-pace for MRL threshold" — home-dashboard panel.
//
// Fully self-resolving: severity is recomputed by the mrl-pace-check cron
// every 4 hours; rows appear, downgrade, and drop off on their own. No
// manual unreviewed/in-progress/resolved state (deliberate contrast with
// the stale-clients panel above it).
//
// Sorted worst-first (Critical → At Risk, then ascending pace ratio). Each
// row shows the pace math + the diagnostic signals so triage starts with a
// "why", not just a "what": pipeline depth, domain health, 7-day velocity,
// projection, and last cycle's count at the same day-of-cycle.

import Link from "next/link";
import { Gauge } from "lucide-react";
import { useMrlPace, type MrlPaceClient } from "@/lib/hooks/use-mrl-pace";

const ROOT_CAUSE_LABEL: Record<string, string> = {
  low_infrastructure: "Unhealthy inboxes",
  low_pipeline: "Low campaign pipeline",
  leads_not_converting: "Leads not converting",
  velocity_dropping: "Velocity dropping",
  unknown: "Cause unclear",
};

const SEVERITY_META = {
  critical: {
    label: "Critical",
    pill: "bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/40",
    bar: "bg-red-500 dark:bg-red-400",
    row: "border-red-200 dark:border-red-500/25 bg-red-50/60 dark:bg-red-950/20 hover:bg-red-100/70 dark:hover:bg-red-950/40",
  },
  at_risk: {
    label: "At Risk",
    pill: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/40",
    bar: "bg-amber-500 dark:bg-amber-400",
    row: "border-amber-200 dark:border-amber-500/25 bg-amber-50/60 dark:bg-amber-950/20 hover:bg-amber-100/70 dark:hover:bg-amber-950/40",
  },
} as const;

function PaceBar({ c }: { c: MrlPaceClient }) {
  const meta = SEVERITY_META[c.severity];
  const actualPct = Math.min(100, (c.actualMrls / c.threshold) * 100);
  const expectedPct = Math.min(100, (c.expectedMrlsToDate / c.threshold) * 100);
  const projectedPct = Math.min(100, (c.projectedTotal / c.threshold) * 100);
  return (
    <div className="relative h-2 rounded-full bg-zinc-200/80 dark:bg-zinc-800 overflow-visible">
      {/* projected reach at current velocity — faint fill behind the actual */}
      <div
        className="absolute inset-y-0 left-0 rounded-full bg-zinc-400/30 dark:bg-zinc-600/40"
        style={{ width: `${projectedPct}%` }}
      />
      {/* actual delivered */}
      <div
        className={`absolute inset-y-0 left-0 rounded-full ${meta.bar}`}
        style={{ width: `${actualPct}%` }}
      />
      {/* expected-by-today marker */}
      <div
        className="absolute -top-0.5 -bottom-0.5 w-px bg-zinc-500 dark:bg-zinc-300"
        style={{ left: `${expectedPct}%` }}
        title={`Expected by today: ${c.expectedMrlsToDate}`}
      />
    </div>
  );
}

function PaceRow({ c }: { c: MrlPaceClient }) {
  const meta = SEVERITY_META[c.severity];
  const pacePct = Math.round(c.paceRatio * 100);
  const willMakeIt = c.projectedTotal >= c.threshold;
  return (
    <div className={`rounded-lg border px-4 py-3 transition-colors ${meta.row}`}>
      {/* Header line: severity + client + tier | day counter */}
      <div className="flex items-center gap-2.5 flex-wrap">
        <span className={`text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 shrink-0 ${meta.pill}`}>
          {meta.label}
        </span>
        <Link
          href={`/clients/${encodeURIComponent(c.clientTag)}`}
          className="font-semibold text-sm text-zinc-900 dark:text-zinc-100 hover:underline truncate"
        >
          {c.clientTag}
        </Link>
        <span className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
          {c.companyName !== c.clientTag ? c.companyName : ""}{c.plan ? ` · ${c.plan}` : ""}
        </span>
        <span className="ml-auto text-[11px] text-zinc-500 dark:text-zinc-400 tabular-nums shrink-0">
          day {c.daysElapsed} of {c.cycleLength}
        </span>
      </div>

      {/* Pace bar + numbers */}
      <div className="mt-2.5 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <PaceBar c={c} />
        </div>
        <span className="text-xs font-medium text-zinc-800 dark:text-zinc-200 tabular-nums shrink-0">
          {c.actualMrls} <span className="text-zinc-400 dark:text-zinc-500 font-normal">/ {c.threshold} MRLs</span>
        </span>
        <span className={`text-xs font-semibold tabular-nums shrink-0 ${
          c.severity === "critical" ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"
        }`}>
          {pacePct}% pace
        </span>
      </div>

      {/* Diagnostics line */}
      <div className="mt-2 flex items-center gap-x-4 gap-y-1 flex-wrap text-[11px] text-zinc-600 dark:text-zinc-400 tabular-nums">
        <span>
          {c.velocity7d}/day
          <span className="text-zinc-400 dark:text-zinc-500"> → </span>
          <span className={willMakeIt ? "text-emerald-600 dark:text-emerald-400 font-medium" : "font-medium"}>
            projects {c.projectedTotal}
          </span>
          <span className="text-zinc-400 dark:text-zinc-500"> by cycle end</span>
        </span>
        {c.priorCycleActualAtSameDay !== null && (
          <span>
            last cycle by day {c.daysElapsed}: <span className="font-medium">{c.priorCycleActualAtSameDay}</span>
          </span>
        )}
        <span>
          pipeline <span className="font-medium">{c.signals.leadsInPipeline.toLocaleString()}</span> leads
        </span>
        <span>
          domains <span className="font-medium text-emerald-600 dark:text-emerald-400">{c.signals.healthyDomains}✓</span>
          {c.signals.flaggedDomains > 0 && (
            <span className="font-medium text-red-500 dark:text-red-400"> {c.signals.flaggedDomains}⚠</span>
          )}
        </span>
        <span className="ml-auto rounded-md bg-zinc-900/5 dark:bg-zinc-100/10 border border-zinc-300/60 dark:border-zinc-600/50 px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 dark:text-zinc-300">
          {ROOT_CAUSE_LABEL[c.rootCauseHint] ?? c.rootCauseHint}
        </span>
      </div>
    </div>
  );
}

export function MrlPacePanel() {
  const { flagged, isLoading } = useMrlPace();
  if (isLoading || flagged.length === 0) return null;

  const critical = flagged.filter((c) => c.severity === "critical").length;
  const atRisk = flagged.length - critical;
  const borderTone = critical > 0
    ? "border-red-400 dark:border-red-600"
    : "border-amber-400 dark:border-amber-600";
  const bgTone = critical > 0
    ? "bg-red-50/50 dark:bg-red-950/15"
    : "bg-amber-50/50 dark:bg-amber-950/15";

  return (
    <div className={`rounded-xl border-2 p-5 ${borderTone} ${bgTone}`}>
      <div className="flex items-start gap-4">
        <Gauge className={`h-7 w-7 mt-0.5 shrink-0 ${critical > 0 ? "text-red-500 dark:text-red-400" : "text-amber-500 dark:text-amber-400"}`} />
        <div className="flex-1 min-w-0 space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <div>
              <h2 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">
                Clients off-pace for MRL threshold
              </h2>
              <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-0.5">
                Behind expected pace for the current billing cycle — self-resolves as MRLs catch up
              </p>
            </div>
            <div className="ml-auto flex items-center gap-1.5 shrink-0">
              {critical > 0 && (
                <span className={`text-[11px] font-semibold rounded-full px-2.5 py-1 ${SEVERITY_META.critical.pill}`}>
                  {critical} critical
                </span>
              )}
              {atRisk > 0 && (
                <span className={`text-[11px] font-semibold rounded-full px-2.5 py-1 ${SEVERITY_META.at_risk.pill}`}>
                  {atRisk} at risk
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            {flagged.map((c) => (
              <PaceRow key={c.clientTag} c={c} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
