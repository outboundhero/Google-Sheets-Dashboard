"use client";

import { use, useMemo, useState, useEffect, useCallback } from "react";
import { ArrowLeft, Users, CheckCircle2, CalendarCheck, Sparkles, Clock, AlertTriangle, Globe, Mail, Loader2, X } from "lucide-react";
import Link from "next/link";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
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
  const [showDomainsDialog, setShowDomainsDialog] = useState(false);

  interface DomainRow {
    domain: string;
    inbox_count: number;
    tags?: string[];
    total_sent?: number;
    total_replied?: number;
    total_bounced?: number;
    outlook_count?: number;
    google_count?: number;
  }
  const [domains, setDomains] = useState<DomainRow[]>([]);
  const [domainsLoading, setDomainsLoading] = useState(false);

  const loadDomains = useCallback(async () => {
    if (!clientTag) return;
    setDomainsLoading(true);
    try {
      const res = await fetch(`/api/deliverability/domains?tags=${encodeURIComponent(clientTag)}`);
      const data = await res.json();
      if (Array.isArray(data)) setDomains(data);
    } catch { /* ignore */ }
    setDomainsLoading(false);
  }, [clientTag]);

  useEffect(() => { loadDomains(); }, [loadDomains]);

  const domainStats = useMemo(() => {
    let outlook = 0, google = 0, flagged = 0;
    for (const d of domains) {
      outlook += d.outlook_count || 0;
      google += d.google_count || 0;
      // Flagging logic
      const isG = (d.google_count || 0) > 0 && (d.outlook_count || 0) === 0;
      const isO = (d.outlook_count || 0) > 0 && (d.google_count || 0) === 0;
      const hasSent = (d.total_sent || 0) > 100;
      if (isG && hasSent && ((d.total_replied || 0) <= 2 || (d.total_bounced || 0) > 20)) flagged++;
      else if (isO && hasSent && ((d.total_replied || 0) <= 16 || (d.total_bounced || 0) > 170)) flagged++;
    }
    return { total: domains.length, outlook, google, flagged };
  }, [domains]);

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

  // Billing Start Date for this client (Start Date from the tracker sheet)
  const billingStartDate = useMemo(() => {
    const row = trackerClients.find(
      (c) => c.clientAbbr.trim().toLowerCase() === clientTag.trim().toLowerCase()
    );
    // Use startDate for billing; fall back to goLiveDate if not available
    const dateStr = row?.startDate || row?.goLiveDate;
    if (!dateStr) return null;
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d;
  }, [trackerClients, clientTag]);

  const analytics = useMemo(() => {
    if (!clientLeads.length) return null;
    return computeAnalytics(clientLeads, undefined, undefined, billingStartDate);
  }, [clientLeads, billingStartDate]);

  const leadsOverTime = analytics?.leadsOverTime || [];

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
            <LeadsOverTimeChart data={leadsOverTime} billingStartDate={billingStartDate} />
          </div>
        </>
      )}

      {/* Domains Section */}
      {domains.length > 0 && (
        <button
          onClick={() => setShowDomainsDialog(true)}
          className="w-full rounded-xl border bg-card p-4 hover:bg-muted/30 transition-colors text-left"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-muted p-2">
                <Globe className="h-4 w-4 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium">Domains</p>
                <p className="text-xs text-muted-foreground">{domainStats.total} domains · Click to view details</p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              {domainStats.outlook > 0 && (
                <div className="text-center">
                  <p className="text-lg font-semibold text-blue-400">{domainStats.outlook}</p>
                  <p className="text-[10px] text-muted-foreground">Outlook</p>
                </div>
              )}
              {domainStats.google > 0 && (
                <div className="text-center">
                  <p className="text-lg font-semibold text-red-400">{domainStats.google}</p>
                  <p className="text-[10px] text-muted-foreground">Google</p>
                </div>
              )}
              {domainStats.flagged > 0 && (
                <div className="text-center">
                  <p className="text-lg font-semibold text-destructive">{domainStats.flagged}</p>
                  <p className="text-[10px] text-muted-foreground">Flagged</p>
                </div>
              )}
            </div>
          </div>
        </button>
      )}

      {/* Domains Dialog */}
      <Dialog open={showDomainsDialog} onOpenChange={setShowDomainsDialog}>
        <DialogContent className="max-w-5xl max-h-[85vh] flex flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle className="text-lg">{clientTag} — {domainStats.total} Domains</DialogTitle>
            <div className="flex gap-4 mt-2">
              {domainStats.outlook > 0 && (
                <div className="flex items-center gap-1.5">
                  <div className="h-2 w-2 rounded-full bg-blue-400" />
                  <span className="text-xs text-muted-foreground">{domainStats.outlook} Outlook</span>
                </div>
              )}
              {domainStats.google > 0 && (
                <div className="flex items-center gap-1.5">
                  <div className="h-2 w-2 rounded-full bg-red-400" />
                  <span className="text-xs text-muted-foreground">{domainStats.google} Google</span>
                </div>
              )}
              {domainStats.flagged > 0 && (
                <div className="flex items-center gap-1.5">
                  <AlertTriangle className="h-3 w-3 text-destructive" />
                  <span className="text-xs text-destructive">{domainStats.flagged} Flagged</span>
                </div>
              )}
            </div>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto rounded-lg border mt-3">
            <table className="w-full">
              <thead className="sticky top-0 z-10">
                <tr className="bg-muted/50 border-b text-[11px] text-muted-foreground">
                  <th className="text-left font-medium px-5 py-2.5">Domain</th>
                  <th className="text-left font-medium px-3 py-2.5">Tags</th>
                  <th className="text-center font-medium px-3 py-2.5 w-20">Inboxes</th>
                  <th className="text-center font-medium px-3 py-2.5 w-24">Sent</th>
                  <th className="text-center font-medium px-3 py-2.5 w-24">Replied</th>
                  <th className="text-center font-medium px-3 py-2.5 w-24">Bounced</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {domains.map((d) => {
                  const isG = (d.google_count || 0) > 0 && (d.outlook_count || 0) === 0;
                  const isO = (d.outlook_count || 0) > 0 && (d.google_count || 0) === 0;
                  const hasSent = (d.total_sent || 0) > 100;
                  const lowReply = isG ? 2 : 16;
                  const highBounce = isG ? 20 : 170;
                  const isFlagged = (isG || isO) && hasSent && ((d.total_replied || 0) <= lowReply || (d.total_bounced || 0) > highBounce);
                  const replyRate = (d.total_sent || 0) > 0 ? ((d.total_replied || 0) / (d.total_sent || 1) * 100).toFixed(1) : "0";
                  const bounceRate = (d.total_sent || 0) > 0 ? ((d.total_bounced || 0) / (d.total_sent || 1) * 100).toFixed(1) : "0";
                  const flagReasons: string[] = [];
                  if ((isG || isO) && hasSent) {
                    if ((d.total_replied || 0) <= lowReply) flagReasons.push("Low replies");
                    if ((d.total_bounced || 0) > highBounce) flagReasons.push("High bounces");
                  }

                  return (
                    <tr key={d.domain} className={`${isFlagged ? "bg-destructive/5" : "hover:bg-muted/30"} transition-colors`}>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          <span className="text-sm font-medium">{d.domain}</span>
                          {isFlagged && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="shrink-0 cursor-help">
                                  <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="right" className="bg-destructive/95 text-destructive-foreground border-destructive/50 text-xs">
                                {flagReasons.join(" · ")}
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex gap-1 flex-wrap">
                          {d.tags?.map((t) => (
                            <span key={t} className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">{t}</span>
                          ))}
                        </div>
                      </td>
                      <td className="text-center px-3 py-3">
                        <span className="text-sm font-medium">{d.inbox_count}</span>
                        <div className="flex justify-center gap-1.5 mt-0.5">
                          {(d.outlook_count || 0) > 0 && <span className="text-[10px] text-blue-400">{d.outlook_count} OL</span>}
                          {(d.google_count || 0) > 0 && <span className="text-[10px] text-red-400">{d.google_count} G</span>}
                        </div>
                      </td>
                      <td className="text-center px-3 py-3 text-sm tabular-nums">{(d.total_sent || 0).toLocaleString()}</td>
                      <td className="text-center px-3 py-3">
                        <span className={`text-sm tabular-nums ${isFlagged && flagReasons.includes("Low replies") ? "text-destructive font-medium" : ""}`}>
                          {(d.total_replied || 0).toLocaleString()}
                        </span>
                        <p className="text-[10px] text-muted-foreground">{replyRate}%</p>
                      </td>
                      <td className="text-center px-3 py-3">
                        <span className={`text-sm tabular-nums ${isFlagged && flagReasons.includes("High bounces") ? "text-destructive font-medium" : ""}`}>
                          {(d.total_bounced || 0).toLocaleString()}
                        </span>
                        <p className="text-[10px] text-muted-foreground">{bounceRate}%</p>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </DialogContent>
      </Dialog>

      <div>
        <h2 className="text-lg font-semibold mb-4">All Leads</h2>
        <DataTable columns={columns} data={clientLeads} hideClientFilter />
      </div>
    </div>
  );
}
