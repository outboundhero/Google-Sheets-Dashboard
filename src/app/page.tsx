"use client";

import { useState, useMemo } from "react";
import {
  Users,
  CheckCircle2,
  CalendarCheck,
  Sparkles,
  RefreshCw,
  Clock,
  AlertTriangle,
} from "lucide-react";
import { useAnalytics } from "@/lib/hooks/use-analytics";
import { useSheets } from "@/lib/hooks/use-sheets";
import { PageHeader } from "@/components/shared/page-header";
import { StatCard } from "@/components/dashboard/stat-card";
import { LeadsByStatusChart } from "@/components/dashboard/leads-by-status-chart";
import { LeadsOverTimeChart } from "@/components/dashboard/leads-over-time-chart";
import { TopClientsTable } from "@/components/dashboard/top-clients-table";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

export default function DashboardPage() {
  const [selectedClient, setSelectedClient] = useState<string>("");
  const { analytics, isLoading, mutate } = useAnalytics(
    selectedClient || undefined
  );
  const { sheets } = useSheets();

  // Unique client tags for the filter dropdown
  const clientTags = useMemo(() => {
    const tags = new Set(sheets.map((s) => s.clientTag));
    return Array.from(tags).sort();
  }, [sheets]);

  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await fetch("/api/cache", { method: "DELETE" });
      await mutate();
    } finally {
      setRefreshing(false);
    }
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
        <Button variant="outline" size="icon" onClick={handleRefresh} disabled={refreshing} className="shrink-0">
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
        </Button>
      </PageHeader>

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

      {/* Stale Clients Alert */}
      {analytics.clientsWithoutRecentMeetingReady.length > 0 && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/20 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-500 mt-0.5 shrink-0" />
            <div className="flex-1 space-y-2">
              <h3 className="font-semibold text-amber-900 dark:text-amber-100">
                Clients without meeting-ready leads for the past 4 days
              </h3>
              <div className="flex flex-wrap gap-2">
                {analytics.clientsWithoutRecentMeetingReady.map((client) => (
                  <span
                    key={client}
                    className="inline-flex items-center rounded-md bg-amber-100 dark:bg-amber-900/40 px-2.5 py-0.5 text-sm font-medium text-amber-800 dark:text-amber-300"
                  >
                    {client}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Client Performance */}
      <TopClientsTable data={analytics.topClients} />
    </div>
  );
}
