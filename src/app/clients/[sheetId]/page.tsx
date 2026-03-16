"use client";

import { use, useMemo, useState } from "react";
import { ArrowLeft, Users, CheckCircle2, CalendarCheck, Sparkles, Clock, AlertTriangle } from "lucide-react";
import Link from "next/link";
import { useAllLeads } from "@/lib/hooks/use-leads";
import { useSheets } from "@/lib/hooks/use-sheets";
import { useClientTracker } from "@/lib/hooks/use-client-tracker";
import { PageHeader } from "@/components/shared/page-header";
import { StatCard } from "@/components/dashboard/stat-card";
import { LeadsByStatusChart } from "@/components/dashboard/leads-by-status-chart";
import { LeadsOverTimeChart } from "@/components/dashboard/leads-over-time-chart";
import { DataTable } from "@/components/leads-table/data-table";
import { columns } from "@/components/leads-table/columns";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { computeAnalytics } from "@/lib/analytics";

/**
 * Convert calendar-month time series to "Month N" labels relative to goLiveDate.
 * Months before go-live are shown as "Aug '25" style.
 * Month of go-live = "Month 1", following months = "Month 2", etc.
 */
function toMonthLabels(
  data: { date: string; count: number }[],
  goLiveDate: Date
): { date: string; count: number }[] {
  const goLiveYear = goLiveDate.getFullYear();
  const goLiveMonth = goLiveDate.getMonth() + 1; // 1-indexed

  return data.map(({ date, count }) => {
    const [yearStr, monthStr] = date.split("-");
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    const monthNum = (year - goLiveYear) * 12 + (month - goLiveMonth) + 1;

    if (monthNum >= 1) {
      return { date: `Month ${monthNum}`, count };
    }
    // Pre-launch: show short calendar label
    const d = new Date(year, month - 1);
    const label = d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
    return { date: label, count };
  });
}

export default function ClientDetailPage({
  params,
}: {
  params: Promise<{ sheetId: string }>;
}) {
  // The route param is actually a clientTag (URL-encoded)
  const { sheetId: rawClientTag } = use(params);
  const clientTag = decodeURIComponent(rawClientTag);
  const { leads: allLeads, isLoading } = useAllLeads();
  const { sheets } = useSheets();
  const { clients: trackerClients } = useClientTracker();

  const [selectedSheetFilter, setSelectedSheetFilter] = useState<string>("all");

  // Get all sheets for this client tag
  const clientSheets = useMemo(
    () => sheets.filter((s) => s.clientTag === clientTag),
    [sheets, clientTag]
  );

  // Filter leads by client tag and optionally by sheet
  const clientLeads = useMemo(() => {
    const leadsForClient = allLeads.filter((l) => l.sheetClientTag === clientTag);
    if (selectedSheetFilter === "all") return leadsForClient;
    return leadsForClient.filter((l) => l.sheetId === selectedSheetFilter);
  }, [allLeads, clientTag, selectedSheetFilter]);

  const analytics = useMemo(() => {
    if (!clientLeads.length) return null;
    return computeAnalytics(clientLeads);
  }, [clientLeads]);

  // Go Live Date for this client from the tracker sheet
  const goLiveDate = useMemo(() => {
    const row = trackerClients.find(
      (c) => c.clientAbbr.trim().toLowerCase() === clientTag.trim().toLowerCase()
    );
    if (!row?.goLiveDate) return null;
    const d = new Date(row.goLiveDate);
    return isNaN(d.getTime()) ? null : d;
  }, [trackerClients, clientTag]);

  // Transform leadsOverTime to "Month N" if we have a go-live date
  const leadsOverTime = useMemo(() => {
    if (!analytics) return [];
    if (!goLiveDate) return analytics.leadsOverTime;
    return toMonthLabels(analytics.leadsOverTime, goLiveDate);
  }, [analytics, goLiveDate]);

  // Compute 24h meeting-ready and missing status metrics
  const meetingReadyMetrics = useMemo(() => {
    if (!clientLeads.length) return { last24h: 0, withoutStatus: 0 };

    const now = new Date();
    const pstOffset = -8 * 60;
    const nowPst = new Date(now.getTime() + (pstOffset + now.getTimezoneOffset()) * 60000);
    const twentyFourHoursAgoPst = new Date(nowPst.getTime() - 24 * 60 * 60 * 1000);

    let last24h = 0;
    let withoutStatus = 0;

    for (const lead of clientLeads) {
      if (lead.currentCategory.toLowerCase().includes("meeting")) {
        const parseDate = (dateStr: string) => {
          if (!dateStr) return null;
          const parsed = new Date(dateStr);
          return isNaN(parsed.getTime()) ? null : parsed;
        };

        const replyDate = parseDate(lead.timeWeGotReply) || parseDate(lead.replyTime);
        if (replyDate) {
          const replyPst = new Date(replyDate.getTime() + (pstOffset + replyDate.getTimezoneOffset()) * 60000);
          if (replyPst >= twentyFourHoursAgoPst) last24h++;
        }

        if (!lead.status.trim()) withoutStatus++;
      }
    }

    return { last24h, withoutStatus };
  }, [clientLeads]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
        <Skeleton className="h-80" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/clients">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <PageHeader
            title={clientTag}
            description={`${clientLeads.length} leads${
              clientSheets.length > 1 ? ` across ${clientSheets.length} sheets` : ""
            }`}
          />
        </div>

        {clientSheets.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Filter by sheet:</span>
            <Select value={selectedSheetFilter} onValueChange={setSelectedSheetFilter}>
              <SelectTrigger className="w-[280px]">
                <SelectValue placeholder="Select a sheet" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  All Sheets ({clientSheets.length})
                </SelectItem>
                {clientSheets.map((sheet) => (
                  <SelectItem key={sheet.id} value={sheet.id}>
                    {sheet.name} {sheet.sheetName && `(${sheet.sheetName})`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {analytics && (
        <>
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
              icon={CalendarCheck}
            />
            <StatCard
              title="Interested"
              value={analytics.interestedLeads.toLocaleString()}
              icon={Sparkles}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <StatCard
              title="Meeting-Ready (24h)"
              value={meetingReadyMetrics.last24h.toLocaleString()}
              subtitle="Delivered in past 24 hours (PST)"
              icon={Clock}
            />
            <StatCard
              title="Missing Status"
              value={meetingReadyMetrics.withoutStatus.toLocaleString()}
              subtitle="Meeting-ready leads without status"
              icon={AlertTriangle}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <LeadsByStatusChart data={analytics.leadsByStatus} />
            <LeadsOverTimeChart data={leadsOverTime} billingStartDay={goLiveDate ? goLiveDate.getDate() : null} />
          </div>
        </>
      )}

      <div>
        <h2 className="text-lg font-semibold mb-4">All Leads</h2>
        <DataTable columns={columns} data={clientLeads} hideClientFilter />
      </div>
    </div>
  );
}
