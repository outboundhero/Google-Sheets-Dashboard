"use client";

import { useState, useMemo } from "react";
import {
  Users,
  CheckCircle2,
  CalendarCheck,
  Sparkles,
  Clock,
  AlertTriangle,
  XCircle,
  RefreshCw,
} from "lucide-react";
import Link from "next/link";
import { useAnalytics } from "@/lib/hooks/use-analytics";
import { useAllLeads } from "@/lib/hooks/use-leads";
import { useSheets } from "@/lib/hooks/use-sheets";
import { useClientTracker } from "@/lib/hooks/use-client-tracker";
import { useNotDeliveredTodayAggregate } from "@/lib/hooks/use-not-delivered-today";
import { useAuth } from "@/lib/auth-context";
import { useTriageStatus, nextStatus, type TriageStatus } from "@/lib/hooks/use-triage-status";
import { ResolveTriageDialog } from "@/components/dashboard/resolve-triage-dialog";
import { PageHeader } from "@/components/shared/page-header";
import { RefreshButton } from "@/components/shared/refresh-button";
import { StatCard } from "@/components/dashboard/stat-card";
import { LeadsByStatusChart } from "@/components/dashboard/leads-by-status-chart";
import { LeadsOverTimeChart } from "@/components/dashboard/leads-over-time-chart";
import { TopClientsTable } from "@/components/dashboard/top-clients-table";
import { RedirectIssuesCard } from "@/components/dashboard/redirect-issues-card";
import { TagAlignmentCard } from "@/components/dashboard/tag-alignment-card";
import { CrossTagAuditCard } from "@/components/dashboard/cross-tag-audit-card";
import { DuplicateDomainsCard } from "@/components/dashboard/duplicate-domains-card";
import { AttachFailuresCard } from "@/components/dashboard/attach-failures-card";
import { PendingOffboardingsCard } from "@/components/dashboard/pending-offboardings-card";
import { MrlPacePanel } from "@/components/dashboard/mrl-pace-panel";
import { OffboardingProgressCard, type OffboardingPlan } from "@/components/dashboard/offboarding-progress-card";
import { ChurnedOffboardDialog } from "@/components/dashboard/churned-offboard-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const TRIAGE_META: Record<TriageStatus, { label: string; dot: string; wrap: string }> = {
  unreviewed: {
    label: "Unreviewed",
    // solid white dot with a gray ring — clearly "not started" (⬜) and visible on amber
    dot: "bg-white border-2 border-gray-400 dark:border-gray-500",
    wrap: "bg-amber-100 dark:bg-amber-900/50 border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-200",
  },
  in_progress: {
    label: "In progress",
    dot: "bg-yellow-400 border-2 border-yellow-500",
    wrap: "bg-yellow-100 dark:bg-yellow-900/40 border-yellow-400 dark:border-yellow-600 text-yellow-900 dark:text-yellow-100",
  },
  resolved: {
    label: "Resolved",
    dot: "bg-emerald-500 border-2 border-emerald-600",
    wrap: "bg-emerald-100 dark:bg-emerald-900/40 border-emerald-400 dark:border-emerald-600 text-emerald-900 dark:text-emerald-200",
  },
};

export default function DashboardPage() {
  const [selectedClient, setSelectedClient] = useState<string>("");
  const { analytics, isLoading, mutate } = useAnalytics(
    selectedClient || undefined
  );
  const { isSyncing, syncProgress, refresh } = useAllLeads();
  const { sheets } = useSheets();
  const { clients: trackerClients, refresh: refreshTracker } = useClientTracker();
  const [trackerRefreshing, setTrackerRefreshing] = useState(false);

  // Churned Clients → Offboard flow. The confirmation dialog opens first
  // (setChurnedOffboardTarget), fetches the plan, and hands it up here on
  // confirm — the actual step walker runs inside OffboardingProgressCard at
  // the top of the dashboard.
  const [churnedOffboardTarget, setChurnedOffboardTarget] = useState<
    { clientAbbr: string; companyName: string; churnDate: string } | null
  >(null);
  const [activeChurnedOffboarding, setActiveChurnedOffboarding] = useState<
    { plan: OffboardingPlan; clientAbbr: string; companyName: string; churnDate: string } | null
  >(null);
  const { total: notDeliveredTotal, byClient: notDeliveredByClient } = useNotDeliveredTodayAggregate();
  const { user, role } = useAuth();
  const isAdmin = role === "admin";

  // Shared triage status for the stale-clients panel (passes current panel tags
  // so the API auto-resets clients that dropped off the panel).
  const staleTags = useMemo(
    () => (analytics?.clientsWithoutRecentMeetingReady || []).map((c) => c.client),
    [analytics],
  );
  // `!!analytics` gates the prune: until analytics has loaded, staleTags is []
  // and we must NOT tell the API the panel is empty (it would reset all statuses).
  const { statuses: triageStatuses, setStatus: setTriageStatus } = useTriageStatus(staleTags, !!analytics);

  // Resolving a client opens a dialog to capture the diagnosis (reason + fix)
  // before the status flips — those flow into the Slack notification. Other
  // transitions (→ in_progress, → unreviewed) apply immediately.
  const [resolvingClient, setResolvingClient] = useState<string | null>(null);
  function cycleTriage(client: string, current: TriageStatus) {
    const next = nextStatus(current);
    if (next === "resolved") {
      setResolvingClient(client);
      return;
    }
    setTriageStatus(client, next, user?.email || null);
  }

  // Set of tracked client tags for fast lookup
  const trackedClientTags = useMemo(
    () => new Set(sheets.map((s) => s.clientTag.trim().toLowerCase())),
    [sheets]
  );

  // Clients going off soon: future churn OR future pause date, only for tracked clients
  const clientsGoingOff = useMemo(() => {
    const now = new Date();
    return trackerClients
      .filter((c) => {
        // Only show clients that are actually tracked in this dashboard
        if (!trackedClientTags.has(c.clientAbbr.trim().toLowerCase())) return false;
        const churnDate = c.churnDate ? new Date(c.churnDate) : null;
        const pauseDate = c.pauseDate ? new Date(c.pauseDate) : null;
        const hasUpcomingChurn = churnDate && !isNaN(churnDate.getTime()) && churnDate > now;
        const hasUpcomingPause = pauseDate && !isNaN(pauseDate.getTime()) && pauseDate > now;
        return hasUpcomingChurn || hasUpcomingPause;
      })
      .map((c) => {
        const churnDate = c.churnDate ? new Date(c.churnDate) : null;
        const pauseDate = c.pauseDate ? new Date(c.pauseDate) : null;
        const now = new Date();
        const hasUpcomingChurn = churnDate && !isNaN(churnDate.getTime()) && churnDate > now;
        const offDate = hasUpcomingChurn ? c.churnDate! : c.pauseDate!;
        const isPause = !hasUpcomingChurn;
        return { ...c, offDate, isPause };
      })
      .sort((a, b) => new Date(a.offDate).getTime() - new Date(b.offDate).getTime());
  }, [trackerClients]);

  // Already churned clients (churn date in the past)
  const churnedClients = useMemo(() => {
    const now = new Date();
    return trackerClients
      .filter((c) => {
        if (!c.churnDate) return false;
        const d = new Date(c.churnDate);
        return !isNaN(d.getTime()) && d <= now;
      })
      .sort((a, b) => new Date(b.churnDate!).getTime() - new Date(a.churnDate!).getTime());
  }, [trackerClients]);

  // Unique client tags for the filter dropdown
  const clientTags = useMemo(() => {
    const tags = new Set(sheets.map((s) => s.clientTag));
    return Array.from(tags).sort();
  }, [sheets]);

  const handleRefresh = async () => {
    await refresh();
    await fetch("/api/cache", { method: "DELETE" });
    await mutate();
  };

  if (isLoading) {
    return (
      <div className="space-y-8">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-[120px] rounded-xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-[320px] rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (!analytics || analytics.totalLeads === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="rounded-full bg-muted p-4 mb-4">
          <Sparkles className="h-8 w-8 text-muted-foreground" />
        </div>
        <h2 className="text-lg font-semibold">No data yet</h2>
        <p className="text-muted-foreground mt-1 max-w-sm">
          Add your Google Sheets in Settings to start seeing analytics here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Dashboard"
        description="Overview of all your lead data across clients"
      >
        <Select
          value={selectedClient}
          onValueChange={(v) => setSelectedClient(v === "all" ? "" : v)}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="All Clients" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Clients</SelectItem>
            {clientTags.map((tag) => (
              <SelectItem key={tag} value={tag}>
                {tag}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <RefreshButton onRefresh={handleRefresh} isRefreshing={isSyncing} syncProgress={syncProgress} />
      </PageHeader>

      {/* Pending offboardings — admin only; self-hides when there are none. */}
      {isAdmin && <PendingOffboardingsCard />}

      {/* Clients off-pace for their MRL threshold — fully self-resolving,
          recomputed by the mrl-pace-check cron every 4h. Hidden when empty. */}
      <MrlPacePanel />

      {/* Live offboarding progress (top of dashboard) — fires when an admin
          clicks Offboard on a churned client row and confirms. */}
      {isAdmin && activeChurnedOffboarding && (
        <OffboardingProgressCard
          plan={activeChurnedOffboarding.plan}
          clientAbbr={activeChurnedOffboarding.clientAbbr}
          churnDate={activeChurnedOffboarding.churnDate}
          companyName={activeChurnedOffboarding.companyName}
          allowInsert
          onDismiss={() => setActiveChurnedOffboarding(null)}
        />
      )}

      {/* Clients Going Off + Churned — side by side */}
      {(clientsGoingOff.length > 0 || churnedClients.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Going Off — left */}
          {clientsGoingOff.length > 0 && (
            <div className="rounded-xl border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-950/20 p-4">
              <div className="flex items-center gap-2 mb-3">
                <XCircle className="h-4.5 w-4.5 text-red-500 dark:text-red-400 shrink-0" />
                <div>
                  <h3 className="text-sm font-semibold text-red-700 dark:text-red-200">Clients going off</h3>
                  <p className="text-[11px] text-red-500/70 dark:text-red-400/70">{clientsGoingOff.length} upcoming</p>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                {clientsGoingOff.map((c) => (
                  <Link
                    key={c.clientAbbr}
                    href={`/clients/${encodeURIComponent(c.clientAbbr)}`}
                    className="flex items-center justify-between rounded-lg bg-red-100 dark:bg-red-900/30 border border-red-200 dark:border-red-800/40 px-3 py-2 text-sm hover:bg-red-200/70 dark:hover:bg-red-900/50 transition-colors"
                  >
                    <span className="font-medium text-red-800 dark:text-red-100 truncate">
                      {c.companyName} <span className="font-normal text-red-500/70 dark:text-red-400/60">({c.clientAbbr})</span>
                    </span>
                    <span className="text-[10px] text-red-600 dark:text-red-400 bg-red-200 dark:bg-red-900/60 rounded px-1.5 py-0.5 shrink-0 ml-2">
                      {c.isPause ? "pauses" : "churns"} {formatDate(c.offDate)}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* Churned — right */}
          {churnedClients.length > 0 && (
            <div className="rounded-xl border border-zinc-200 dark:border-zinc-700/50 bg-zinc-50 dark:bg-zinc-900/30 p-4">
              <div className="flex items-center gap-2 mb-3">
                <XCircle className="h-4.5 w-4.5 text-zinc-500 dark:text-zinc-400 shrink-0" />
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">Churned clients</h3>
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-500">{churnedClients.length} total</p>
                </div>
                <button
                  onClick={async () => {
                    if (trackerRefreshing) return;
                    setTrackerRefreshing(true);
                    try { await refreshTracker(); } finally { setTrackerRefreshing(false); }
                  }}
                  disabled={trackerRefreshing}
                  className="ml-auto flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-[10px] text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800/50 disabled:opacity-50 transition-colors"
                  title="Re-read the Client Tracker sheet"
                >
                  <RefreshCw className={`h-3 w-3 ${trackerRefreshing ? "animate-spin" : ""}`} />
                  {trackerRefreshing ? "Refreshing…" : "Refresh"}
                </button>
              </div>
              <div className="max-h-52 overflow-y-auto space-y-1 pr-1">
                {churnedClients.map((c) => (
                  <div
                    key={c.clientAbbr}
                    className="flex items-center justify-between gap-2 rounded-lg px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800/50 transition-colors"
                  >
                    <span className="text-zinc-700 dark:text-zinc-300 truncate min-w-0 flex-1">
                      {c.companyName} <span className="text-zinc-400 dark:text-zinc-600">({c.clientAbbr})</span>
                    </span>
                    {isAdmin && (
                      <button
                        onClick={() => setChurnedOffboardTarget({
                          clientAbbr: c.clientAbbr,
                          companyName: c.companyName,
                          churnDate: c.churnDate!,
                        })}
                        className="text-[10px] font-medium rounded-md bg-amber-500/15 hover:bg-amber-500/25 text-amber-700 dark:text-amber-300 border border-amber-500/30 px-2 py-0.5 shrink-0 transition-colors"
                        title={`Pause campaigns + detach ${c.clientAbbr} tag from inboxes`}
                      >
                        Offboard
                      </button>
                    )}
                    <span className="text-[10px] text-zinc-500 dark:text-zinc-500 shrink-0">
                      {formatDate(c.churnDate!)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Stale Clients Alert */}
      {analytics.clientsWithoutRecentMeetingReady.length > 0 && (
        <div className="rounded-xl border-2 border-amber-400 dark:border-amber-600 bg-amber-50 dark:bg-amber-950/30 p-5">
          <div className="flex items-start gap-4">
            <AlertTriangle className="h-7 w-7 text-amber-500 dark:text-amber-400 mt-0.5 shrink-0" />
            <div className="flex-1 space-y-3">
              <div>
                <h2 className="text-xl font-bold text-amber-900 dark:text-amber-100">
                  Clients without meeting-ready leads for the past 4 days
                </h2>
                <p className="text-sm text-amber-700 dark:text-amber-400 mt-0.5">
                  {analytics.clientsWithoutRecentMeetingReady.length} client{analytics.clientsWithoutRecentMeetingReady.length !== 1 ? "s" : ""} need attention — click the dot to set status, name to view leads
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {analytics.clientsWithoutRecentMeetingReady.map(({ client, lastMeetingReadyDate }) => {
                  const status = (triageStatuses[client]?.status || "unreviewed") as TriageStatus;
                  const meta = TRIAGE_META[status];
                  const updatedBy = triageStatuses[client]?.updated_by;
                  const needs = triageStatuses[client]?.needs || [];
                  return (
                    <div
                      key={client}
                      className={`inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm font-semibold transition-colors ${meta.wrap}`}
                    >
                      <button
                        type="button"
                        onClick={() => cycleTriage(client, status)}
                        title={`${meta.label}${updatedBy ? ` · by ${updatedBy}` : ""} — click to change`}
                        className="flex items-center shrink-0 rounded-full hover:scale-110 transition-transform"
                        aria-label={`Status: ${meta.label}. Click to change.`}
                      >
                        <span className={`h-3 w-3 rounded-full ring-2 ring-black/5 ${meta.dot}`} />
                      </button>
                      <Link
                        href={`/clients/${encodeURIComponent(client)}`}
                        className={`hover:underline ${status === "resolved" ? "line-through opacity-70" : ""}`}
                      >
                        {client}
                      </Link>
                      <span className="text-xs font-normal opacity-70 bg-black/5 dark:bg-white/10 rounded px-1.5 py-0.5">
                        {lastMeetingReadyDate ? `last: ${new Date(lastMeetingReadyDate).toLocaleDateString()}` : "no data"}
                      </span>
                      {needs[0] && (
                        <span className="text-xs font-normal rounded bg-black/10 dark:bg-white/15 px-1.5 py-0.5">
                          {needs[0]}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Replacement attach failures — admin only; self-hides when none. */}
      {isAdmin && <AttachFailuresCard />}

      {/* Client Tracker tag alignment — admin only; small companion to the redirect audit. */}
      {isAdmin && <TagAlignmentCard />}

      {/* Redirect issues — admin only; flags domains not matching the Client Tracker. */}
      {isAdmin && <RedirectIssuesCard />}

      {/* Cross-tag audit — admin only; domains in wrong-client campaigns. */}
      {isAdmin && <CrossTagAuditCard />}

      {/* Duplicate domains across instances — admin only. */}
      {isAdmin && <DuplicateDomainsCard />}

      <ResolveTriageDialog
        clientTag={resolvingClient}
        open={resolvingClient !== null}
        onOpenChange={(o) => { if (!o) setResolvingClient(null); }}
        onConfirm={({ needs, detail }) => {
          if (resolvingClient) {
            setTriageStatus(resolvingClient, "resolved", user?.email || null, { needs, fixed: detail });
          }
        }}
      />

      {churnedOffboardTarget && (
        <ChurnedOffboardDialog
          open={!!churnedOffboardTarget}
          onOpenChange={(o) => { if (!o) setChurnedOffboardTarget(null); }}
          clientAbbr={churnedOffboardTarget.clientAbbr}
          companyName={churnedOffboardTarget.companyName}
          churnDate={churnedOffboardTarget.churnDate}
          onStart={(plan) => {
            setActiveChurnedOffboarding({
              plan,
              clientAbbr: churnedOffboardTarget.clientAbbr,
              companyName: churnedOffboardTarget.companyName,
              churnDate: churnedOffboardTarget.churnDate,
            });
            setChurnedOffboardTarget(null);
          }}
        />
      )}

      {/* Not Delivered Today */}
      {notDeliveredTotal > 0 && (
        <div className="rounded-xl border-2 border-violet-400 dark:border-violet-600 bg-violet-50 dark:bg-violet-950/30 p-5">
          <div className="flex items-start gap-4">
            <XCircle className="h-7 w-7 text-violet-500 dark:text-violet-400 mt-0.5 shrink-0" />
            <div className="flex-1 space-y-3">
              <div>
                <h2 className="text-xl font-bold text-violet-900 dark:text-violet-100">
                  {notDeliveredTotal} lead{notDeliveredTotal !== 1 ? "s" : ""} not delivered (today + yesterday)
                </h2>
                <p className="text-sm text-violet-700 dark:text-violet-400 mt-0.5">
                  Across {notDeliveredByClient.length} client{notDeliveredByClient.length !== 1 ? "s" : ""} (PST) — click a client to review and mark delivered
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {notDeliveredByClient.filter((c) => c.count > 0).map((c) => (
                  <Link
                    key={c.clientTag}
                    href={`/clients/${encodeURIComponent(c.clientTag)}`}
                    className="inline-flex items-center gap-2 rounded-lg bg-violet-100 dark:bg-violet-900/50 border border-violet-300 dark:border-violet-700 px-3 py-1.5 text-sm font-semibold text-violet-900 dark:text-violet-200 hover:bg-violet-200 dark:hover:bg-violet-800/60 transition-colors"
                  >
                    {c.clientTag}
                    <span className="text-xs font-normal text-violet-700 dark:text-violet-300 bg-violet-200 dark:bg-violet-800/60 rounded px-1.5 py-0.5 tabular-nums">
                      {c.count}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Stat Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Total Leads"
          value={analytics.totalLeads.toLocaleString()}
          icon={Users}
        />
        <StatCard
          title="Quality Leads"
          value={`${analytics.qualityLeadPercentage}%`}
          subtitle={`${analytics.qualityLeads} of ${analytics.totalLeads}`}
          icon={CheckCircle2}
        />
        <StatCard
          title="Meeting-Ready"
          value={analytics.meetingReadyLeads.toLocaleString()}
          subtitle={`${analytics.meetingReadyLast24h} in last 24h`}
          icon={CalendarCheck}
        />
        <StatCard
          title="Interested"
          value={analytics.interestedLeads.toLocaleString()}
          icon={Sparkles}
        />
      </div>

      {/* Additional Metrics */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard
          title="Meeting-Ready (24h)"
          value={analytics.meetingReadyLast24h.toLocaleString()}
          subtitle="Delivered in past 24 hours (PST)"
          icon={Clock}
        />
        <StatCard
          title="Missing Status"
          value={`${analytics.meetingReadyWithoutStatus}/${analytics.meetingReadyWithoutStatusTotal}`}
          subtitle="Meeting-ready leads without status"
          icon={AlertTriangle}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <LeadsByStatusChart data={analytics.leadsByStatus} />
        <LeadsOverTimeChart data={analytics.leadsOverTime} />
      </div>

      {/* Client Performance */}
      <TopClientsTable data={analytics.topClients} />
    </div>
  );
}
