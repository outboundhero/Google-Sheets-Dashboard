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
} from "lucide-react";
import Link from "next/link";
import { useAnalytics } from "@/lib/hooks/use-analytics";
import { useAllLeads } from "@/lib/hooks/use-leads";
import { useSheets } from "@/lib/hooks/use-sheets";
import { useClientTracker } from "@/lib/hooks/use-client-tracker";
import { PageHeader } from "@/components/shared/page-header";
import { RefreshButton } from "@/components/shared/refresh-button";
import { StatCard } from "@/components/dashboard/stat-card";
import { LeadsByStatusChart } from "@/components/dashboard/leads-by-status-chart";
import { LeadsOverTimeChart } from "@/components/dashboard/leads-over-time-chart";
import { TopClientsTable } from "@/components/dashboard/top-clients-table";
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

export default function DashboardPage() {
  const [selectedClient, setSelectedClient] = useState<string>("");
  const { analytics, isLoading, mutate } = useAnalytics(
    selectedClient || undefined
  );
  const { isSyncing, syncProgress, refresh } = useAllLeads();
  const { sheets } = useSheets();
  const { clients: trackerClients } = useClientTracker();

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
                <div>
                  <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">Churned clients</h3>
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-500">{churnedClients.length} total</p>
                </div>
              </div>
              <div className="max-h-52 overflow-y-auto space-y-1 pr-1">
                {churnedClients.map((c) => (
                  <div
                    key={c.clientAbbr}
                    className="flex items-center justify-between rounded-lg px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800/50 transition-colors"
                  >
                    <span className="text-zinc-700 dark:text-zinc-300 truncate">
                      {c.companyName} <span className="text-zinc-400 dark:text-zinc-600">({c.clientAbbr})</span>
                    </span>
                    <span className="text-[10px] text-zinc-500 dark:text-zinc-500 shrink-0 ml-2">
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
                  {analytics.clientsWithoutRecentMeetingReady.length} client{analytics.clientsWithoutRecentMeetingReady.length !== 1 ? "s" : ""} need attention — click to view their leads
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {analytics.clientsWithoutRecentMeetingReady.map(({ client, lastMeetingReadyDate }) => (
                  <Link
                    key={client}
                    href={`/clients/${encodeURIComponent(client)}`}
                    className="inline-flex items-center gap-2 rounded-lg bg-amber-100 dark:bg-amber-900/50 border border-amber-300 dark:border-amber-700 px-3 py-1.5 text-sm font-semibold text-amber-900 dark:text-amber-200 hover:bg-amber-200 dark:hover:bg-amber-800/60 transition-colors"
                  >
                    {client}
                    {lastMeetingReadyDate ? (
                      <span className="text-xs font-normal text-amber-600 dark:text-amber-400 bg-amber-200 dark:bg-amber-800/60 rounded px-1.5 py-0.5">
                        last: {new Date(lastMeetingReadyDate).toLocaleDateString()}
                      </span>
                    ) : (
                      <span className="text-xs font-normal text-amber-600 dark:text-amber-400 bg-amber-200 dark:bg-amber-800/60 rounded px-1.5 py-0.5">
                        no data
                      </span>
                    )}
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
