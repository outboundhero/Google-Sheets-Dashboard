"use client";

import { use, useMemo } from "react";
import { ArrowLeft, Users, CheckCircle2, CalendarCheck, Sparkles, Clock, AlertTriangle } from "lucide-react";
import Link from "next/link";
import { useAllLeads } from "@/lib/hooks/use-leads";
import { PageHeader } from "@/components/shared/page-header";
import { StatCard } from "@/components/dashboard/stat-card";
import { LeadsByStatusChart } from "@/components/dashboard/leads-by-status-chart";
import { LeadsOverTimeChart } from "@/components/dashboard/leads-over-time-chart";
import { DataTable } from "@/components/leads-table/data-table";
import { columns } from "@/components/leads-table/columns";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { computeAnalytics } from "@/lib/analytics";

export default function ClientDetailPage({
  params,
}: {
  params: Promise<{ sheetId: string }>;
}) {
  // The route param is actually a clientTag (URL-encoded)
  const { sheetId: rawClientTag } = use(params);
  const clientTag = decodeURIComponent(rawClientTag);
  const { leads: allLeads, isLoading } = useAllLeads();

  const clientLeads = useMemo(
    () => allLeads.filter((l) => l.clientTag === clientTag),
    [allLeads, clientTag]
  );

  const analytics = useMemo(() => {
    if (!clientLeads.length) return null;
    return computeAnalytics(clientLeads);
  }, [clientLeads]);

  // Compute 24h meeting-ready and missing status metrics
  const meetingReadyMetrics = useMemo(() => {
    if (!clientLeads.length) return { last24h: 0, withoutStatus: 0 };

    // PST timezone calculation
    const now = new Date();
    const pstOffset = -8 * 60;
    const nowPst = new Date(now.getTime() + (pstOffset + now.getTimezoneOffset()) * 60000);
    const twentyFourHoursAgoPst = new Date(nowPst.getTime() - 24 * 60 * 60 * 1000);

    let last24h = 0;
    let withoutStatus = 0;

    for (const lead of clientLeads) {
      if (lead.currentCategory.toLowerCase().includes("meeting")) {
        // Parse date from either timeWeGotReply or replyTime
        const parseDate = (dateStr: string) => {
          if (!dateStr) return null;
          const parsed = new Date(dateStr);
          return isNaN(parsed.getTime()) ? null : parsed;
        };

        const replyDate = parseDate(lead.timeWeGotReply) || parseDate(lead.replyTime);
        if (replyDate) {
          const replyPst = new Date(replyDate.getTime() + (pstOffset + replyDate.getTimezoneOffset()) * 60000);
          if (replyPst >= twentyFourHoursAgoPst) {
            last24h++;
          }
        }

        // Check if meeting-ready without status
        if (!lead.status.trim()) {
          withoutStatus++;
        }
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
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/clients">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <PageHeader
          title={clientTag}
          description={`${clientLeads.length} leads`}
        />
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
            <LeadsOverTimeChart data={analytics.leadsOverTime} />
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
