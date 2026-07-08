"use client";

import { use, useMemo, useState, useEffect, useCallback, useRef } from "react";
import { ArrowLeft, Users, CheckCircle2, CalendarCheck, Sparkles, Clock, AlertTriangle, Globe, Check, Search, X, Loader2, Download, Copy, XCircle } from "lucide-react";
import Link from "next/link";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useAllLeads } from "@/lib/hooks/use-leads";
import { useSheets } from "@/lib/hooks/use-sheets";
import { useClientTracker } from "@/lib/hooks/use-client-tracker";
import { useNotDeliveredToday } from "@/lib/hooks/use-not-delivered-today";
import { isPstToday } from "@/lib/date-utils";
import { useAuth } from "@/lib/auth-context";
import { PageHeader } from "@/components/shared/page-header";
import { LeadsOverTimeChart } from "@/components/dashboard/leads-over-time-chart";
import { DataTable } from "@/components/leads-table/data-table";
import { columns } from "@/components/leads-table/columns";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BulkTagDialog, type TagApplyInfo } from "@/components/deliverability/bulk-tag-dialog";
import { BulkDeleteDialog } from "@/components/deliverability/bulk-delete-dialog";
import { AttachToCampaignsDialog } from "@/components/deliverability/attach-to-campaigns-dialog";
import { RemoveFromCampaignsDialog } from "@/components/deliverability/remove-from-campaigns-dialog";
import { DEFAULT_INSTANCE, type BisonInstanceSlug } from "@/lib/bison-instances";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { computeAnalytics } from "@/lib/analytics";

interface DomainRow {
  domain: string;
  inbox_count: number;
  domain_created_at?: string | null;
  tags?: string[];
  total_sent?: number;
  total_replied?: number;
  total_bounced?: number;
  outlook_count?: number;
  google_count?: number;
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
  const { role } = useAuth();
  const isAdmin = role === "admin";
  const {
    leads: undeliveredLeads,
    count: undeliveredCount,
    mutate: mutateUndelivered,
  } = useNotDeliveredToday(clientTag);
  const [dismissingEmails, setDismissingEmails] = useState<Set<string>>(new Set());

  const handleMarkDelivered = useCallback(async (sheetId: string, leadEmail: string) => {
    const dismissKey = `${sheetId}::${leadEmail}`;
    setDismissingEmails((prev) => new Set(prev).add(dismissKey));
    await mutateUndelivered(
      (prev) => prev ? {
        leads: prev.leads.filter((l) => !(l.email === leadEmail && l.sheetId === sheetId)),
        count: Math.max(0, prev.count - 1),
      } : prev,
      { revalidate: false },
    );
    try {
      await fetch("/api/leads/not-delivered-today", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sheetId, leadEmail, clientTag }),
      });
    } catch {
      // On failure, revalidate so the lead reappears
      mutateUndelivered();
    }
    setDismissingEmails((prev) => {
      const next = new Set(prev);
      next.delete(dismissKey);
      return next;
    });
  }, [clientTag, mutateUndelivered]);

  const [selectedSheetFilter, setSelectedSheetFilter] = useState<string>("all");
  const [showDomainsDialog, setShowDomainsDialog] = useState(false);

  const [domains, setDomains] = useState<DomainRow[]>([]);
  const [domainsLoading, setDomainsLoading] = useState(false);

  // Campaign remaining leads for this client
  interface CampaignInfo { id: number; name: string; remaining_leads: number; status: string }
  const [clientCampaigns, setClientCampaigns] = useState<CampaignInfo[]>([]);
  const [totalRemaining, setTotalRemaining] = useState(0);

  useEffect(() => {
    fetch("/api/campaigns")
      .then((r) => r.json())
      .then((data) => {
        const campaigns = data.campaigns || data;
        if (!Array.isArray(campaigns)) return;
        const matching = campaigns
          .filter((c: CampaignInfo) => c.status === "active")
          .filter((c: Record<string, string>) => {
            const tag = c.client_tag || (c.name?.indexOf(":") > 0 ? c.name.substring(0, c.name.indexOf(":")).trim() : "");
            return tag === clientTag;
          });
        setClientCampaigns(matching);
        setTotalRemaining(matching.reduce((sum: number, c: CampaignInfo) => sum + (c.remaining_leads || 0), 0));
      })
      .catch(() => {});
  }, [clientTag]);

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
    let outlookInboxes = 0, googleInboxes = 0, outlookDomains = 0, googleDomains = 0, flagged = 0;
    for (const d of domains) {
      const ol = d.outlook_count || 0;
      const g = d.google_count || 0;
      outlookInboxes += ol;
      googleInboxes += g;
      if (ol > 0) outlookDomains++;
      if (g > 0) googleDomains++;
      const isG = g > 0 && ol === 0;
      const isO = ol > 0 && g === 0;
      const sent = d.total_sent || 0;
      if ((isG || isO) && sent > 100) {
        const rr = (d.total_replied || 0) / sent;
        const br = (d.total_bounced || 0) / sent;
        if (rr < 0.01 || br > 0.03) flagged++;
      }
    }
    return { total: domains.length, totalInboxes: domains.reduce((s, d) => s + d.inbox_count, 0), outlookDomains, outlookInboxes, googleDomains, googleInboxes, flagged };
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
  const qualityLeadsOverTime = analytics?.qualityLeadsOverTime || [];

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

      {/* Leads Not Delivered Today */}
      {undeliveredCount > 0 && (
        <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-4">
          <div className="flex items-center gap-2 mb-2">
            <XCircle className="h-4 w-4 text-violet-400 shrink-0" />
            <span className="text-sm font-medium text-violet-200">
              {undeliveredCount} lead{undeliveredCount !== 1 ? "s" : ""} not delivered (today + yesterday)
            </span>
            <span className="text-[10px] text-violet-400/70 ml-auto">PST</span>
          </div>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {undeliveredLeads.map((l) => {
              const dismissKey = `${l.sheetId}::${l.email}`;
              const isDismissing = dismissingEmails.has(dismissKey);
              const dayLabel = (isPstToday(l.replyTime) || isPstToday(l.timeWeGotReply)) ? "Today" : "Yesterday";
              return (
                <div
                  key={dismissKey}
                  className="flex items-center justify-between gap-2 text-xs px-2 py-1.5 rounded hover:bg-violet-900/10"
                >
                  <div className="min-w-0 flex-1 flex items-center gap-2">
                    <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded ${dayLabel === "Today" ? "bg-violet-500/30 text-violet-100" : "bg-violet-500/10 text-violet-300/80"}`}>
                      {dayLabel}
                    </span>
                    <span className="text-violet-100/90 font-medium truncate">{l.name || "—"}</span>
                    <span className="text-violet-100/60 truncate">· {l.email}</span>
                    {l.company && (
                      <span className="text-violet-100/50 truncate hidden sm:inline">· {l.company}</span>
                    )}
                  </div>
                  {isAdmin && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[10px] px-2 border-violet-500/40 text-violet-200 hover:bg-violet-500/20 shrink-0"
                      disabled={isDismissing}
                      onClick={() => handleMarkDelivered(l.sheetId, l.email)}
                    >
                      {isDismissing ? "..." : "Delivered"}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Low Remaining Leads Alert */}
      {totalRemaining > 0 && totalRemaining < 1500 && clientCampaigns.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
            <span className="text-sm font-medium text-amber-200">Low Remaining Leads</span>
            <span className="text-xs text-amber-500 font-semibold ml-auto">{totalRemaining.toLocaleString()} remaining</span>
          </div>
          <div className="space-y-1">
            {clientCampaigns.map((c) => (
              <div key={c.id} className="flex items-center justify-between text-xs px-2 py-1 rounded hover:bg-amber-900/20">
                <span className="text-amber-100/70 truncate">{c.name}</span>
                <span className="text-amber-500 shrink-0 ml-2 tabular-nums">{c.remaining_leads.toLocaleString()} left</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {analytics && (
        <>
          {/* Stats Overview */}
          <Card>
            <CardContent className="p-0">
              <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 divide-x divide-y lg:divide-y-0">
                {[
                  { label: "Total Leads", value: analytics.totalLeads.toLocaleString(), icon: Users, sub: null },
                  { label: "Quality Leads", value: `${analytics.qualityLeadPercentage}%`, icon: CheckCircle2, sub: `${analytics.qualityLeads} of ${analytics.totalLeads}` },
                  { label: "Meeting-Ready", value: analytics.meetingReadyLeads.toLocaleString(), icon: CalendarCheck, sub: null },
                  { label: "Interested", value: analytics.interestedLeads.toLocaleString(), icon: Sparkles, sub: null },
                  { label: "Meeting-Ready (24h)", value: meetingReadyMetrics.last24h.toLocaleString(), icon: Clock, sub: "Past 24h (PST)" },
                  { label: "Missing Status", value: meetingReadyMetrics.withoutStatus.toLocaleString(), icon: AlertTriangle, sub: "Without status" },
                ].map((s) => (
                  <div key={s.label} className="flex items-center gap-3 p-4">
                    <div className="rounded-lg bg-muted p-2 shrink-0">
                      <s.icon className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[11px] text-muted-foreground truncate">{s.label}</p>
                      <p className="text-xl font-bold tracking-tight">{s.value}</p>
                      {s.sub && <p className="text-[10px] text-muted-foreground">{s.sub}</p>}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Leads Over Time — full width */}
          <LeadsOverTimeChart data={leadsOverTime} qualityData={qualityLeadsOverTime} billingStartDate={billingStartDate} />
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
                <p className="text-xs text-muted-foreground">{domainStats.total} domains · {domainStats.totalInboxes} inboxes · Click to manage</p>
              </div>
            </div>
            <div className="flex items-center gap-5">
              {domainStats.outlookDomains > 0 && (
                <div className="text-right">
                  <p className="text-sm font-semibold text-blue-400">{domainStats.outlookDomains} <span className="text-[10px] font-normal text-muted-foreground">domains</span></p>
                  <p className="text-[10px] text-muted-foreground">{domainStats.outlookInboxes} Outlook inboxes</p>
                </div>
              )}
              {domainStats.googleDomains > 0 && (
                <div className="text-right">
                  <p className="text-sm font-semibold text-red-400">{domainStats.googleDomains} <span className="text-[10px] font-normal text-muted-foreground">domains</span></p>
                  <p className="text-[10px] text-muted-foreground">{domainStats.googleInboxes} Google inboxes</p>
                </div>
              )}
              {domainStats.flagged > 0 && (
                <div className="text-right">
                  <p className="text-sm font-semibold text-destructive">{domainStats.flagged}</p>
                  <p className="text-[10px] text-muted-foreground">Flagged</p>
                </div>
              )}
            </div>
          </div>
        </button>
      )}

      {/* Domains Dialog — with bulk actions */}
      <ClientDomainsDialog
        open={showDomainsDialog}
        onOpenChange={setShowDomainsDialog}
        clientTag={clientTag}
        domains={domains}
        domainStats={domainStats}
        onDomainsChanged={loadDomains}
      />

      <div>
        <h2 className="text-lg font-semibold mb-4">All Leads</h2>
        <DataTable columns={columns} data={clientLeads} hideClientFilter />
      </div>
    </div>
  );
}

// ─── Client Domains Dialog with bulk actions ────────────────────────────────

function ClientDomainsDialog({
  open,
  onOpenChange,
  clientTag,
  domains,
  domainStats,
  onDomainsChanged,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  clientTag: string;
  domains: DomainRow[];
  domainStats: { total: number; totalInboxes: number; outlookDomains: number; outlookInboxes: number; googleDomains: number; googleInboxes: number; flagged: number };
  onDomainsChanged: () => void;
}) {
  const [selectedDomains, setSelectedDomains] = useState<Set<string>>(new Set());
  const [domainSearch, setDomainSearch] = useState("");
  const [bulkTagMode, setBulkTagMode] = useState<"add" | "remove" | null>(null);
  const [showBulkDelete, setShowBulkDelete] = useState(false);
  const [showAttachCampaigns, setShowAttachCampaigns] = useState(false);
  const [showRemoveFromCampaigns, setShowRemoveFromCampaigns] = useState(false);
  const attachDomainsRef = useRef<string[]>([]);
  const now = Date.now();

  // Background tag + campaign combo state
  interface JobItem { campaign: string; status: "pending" | "running" | "done" | "error"; newly: number; existing: number; error?: string }
  interface TagCampaignJob { tagStatus: "running" | "done" | "error"; tagLabel: string; tagAffected?: number; tagError?: string; campaignJobs: JobItem[]; campaignsDone: boolean; domains: string[] }
  const [tagCampaignJob, setTagCampaignJob] = useState<TagCampaignJob | null>(null);
  const [domainsCopied, setDomainsCopied] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exportCopied, setExportCopied] = useState(false);

  // Drag-to-select
  const isDraggingRef = useRef(false);
  const dragSelectModeRef = useRef(true);

  // Drag-to-select: index-based range to handle fast scrolling
  const dragStartIdx = useRef(-1);
  const dragLastIdx = useRef(-1);

  const handleDragStart = useCallback((idx: number, domain: string) => {
    isDraggingRef.current = true;
    dragStartIdx.current = idx;
    dragLastIdx.current = idx;
    const wasSelected = selectedDomains.has(domain);
    dragSelectModeRef.current = !wasSelected;
    setSelectedDomains((prev) => {
      const next = new Set(prev);
      if (dragSelectModeRef.current) next.add(domain);
      else next.delete(domain);
      return next;
    });
  }, [selectedDomains]);

  const handleDragEnter = useCallback((idx: number, list: DomainRow[]) => {
    if (!isDraggingRef.current || idx === dragLastIdx.current) return;
    const from = Math.min(dragLastIdx.current, idx);
    const to = Math.max(dragLastIdx.current, idx);
    dragLastIdx.current = idx;
    setSelectedDomains((prev) => {
      const next = new Set(prev);
      for (let i = from; i <= to; i++) {
        const d = list[i]?.domain;
        if (!d) continue;
        if (dragSelectModeRef.current) next.add(d);
        else next.delete(d);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const up = () => { isDraggingRef.current = false; dragStartIdx.current = -1; };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const exportDomainsCsv = useCallback((withStats?: boolean) => {
    const selected = domains.filter((d) => selectedDomains.has(d.domain));
    let csv: string;
    if (withStats) {
      const header = "Domain,Date Added,Inboxes,Sent,Replied,Bounced,Tags";
      const rows = selected.map((d) => {
        const dateAdded = d.domain_created_at ? new Date(d.domain_created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
        return `${d.domain},${dateAdded},${d.inbox_count},${d.total_sent || 0},${d.total_replied || 0},${d.total_bounced || 0},"${(d.tags || []).join(", ")}"`;
      });
      csv = [header, ...rows].join("\n");
    } else {
      csv = ["Domain", ...selected.map((d) => d.domain)].join("\n");
    }
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `domains-${selectedDomains.size}${withStats ? "-stats" : ""}.csv`;
    a.click();
    setShowExportMenu(false);
  }, [domains, selectedDomains]);

  const copyDomainsToClipboard = useCallback(() => {
    navigator.clipboard.writeText(Array.from(selectedDomains).join("\n"));
    setExportCopied(true);
    setTimeout(() => { setExportCopied(false); setShowExportMenu(false); }, 1500);
  }, [selectedDomains]);

  const startBackgroundTagCampaign = useCallback(async (info: TagApplyInfo) => {
    const tagLabel = `${info.mode === "add" ? "Adding" : "Removing"} ${info.tagNames.join(", ")}`;
    const campaignJobs: JobItem[] = info.campaigns.map((c) => ({ campaign: c.name, status: "pending" as const, newly: 0, existing: 0 }));
    setTagCampaignJob({ tagStatus: "running", tagLabel, campaignJobs, campaignsDone: info.campaigns.length === 0, domains: info.domains });
    setSelectedDomains(new Set());
    setDomainsCopied(false);

    const tagPromise = fetch("/api/deliverability/bulk-tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: info.mode, tagNames: info.tagNames, domains: info.domains }),
    }).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setTagCampaignJob((prev) => prev ? { ...prev, tagStatus: "done", tagAffected: data.inboxesAffected || 0 } : prev);
    }).catch((err) => {
      setTagCampaignJob((prev) => prev ? { ...prev, tagStatus: "error", tagError: err instanceof Error ? err.message : "Failed" } : prev);
    });

    const campaignPromise = (async () => {
      for (let i = 0; i < info.campaigns.length; i++) {
        const campaign = info.campaigns[i];
        setTagCampaignJob((prev) => prev ? { ...prev, campaignJobs: prev.campaignJobs.map((j, idx) => idx === i ? { ...j, status: "running" } : j) } : prev);
        try {
          const res = await fetch(`/api/deliverability/attach-domains-to-campaign?instance=${campaign.instance}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ campaign_id: campaign.id, domains: info.domains }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          setTagCampaignJob((prev) => prev ? { ...prev, campaignJobs: prev.campaignJobs.map((j, idx) => idx === i ? { ...j, status: "done", newly: data.newly_attached || 0, existing: data.already_attached || 0 } : j) } : prev);
        } catch (err) {
          setTagCampaignJob((prev) => prev ? { ...prev, campaignJobs: prev.campaignJobs.map((j, idx) => idx === i ? { ...j, status: "error", error: err instanceof Error ? err.message : "Failed" } : j) } : prev);
        }
      }
      setTagCampaignJob((prev) => prev ? { ...prev, campaignsDone: true } : prev);
    })();

    await Promise.all([tagPromise, campaignPromise]);
    onDomainsChanged();
  }, [onDomainsChanged]);

  // Reset selection when dialog closes
  useEffect(() => {
    if (!open) { setSelectedDomains(new Set()); setDomainSearch(""); setTagCampaignJob(null); }
  }, [open]);

  const filtered = useMemo(() => {
    if (!domainSearch) return domains;
    const q = domainSearch.toLowerCase();
    return domains.filter((d) => d.domain.toLowerCase().includes(q));
  }, [domains, domainSearch]);

  const getFlagReasons = (d: DomainRow) => {
    const isG = (d.google_count || 0) > 0 && (d.outlook_count || 0) === 0;
    const isO = (d.outlook_count || 0) > 0 && (d.google_count || 0) === 0;
    const sent = d.total_sent || 0;
    const reasons: string[] = [];
    if ((isG || isO) && sent > 100) {
      if ((d.total_replied || 0) / sent < 0.01) reasons.push("Low replies");
      if ((d.total_bounced || 0) / sent > 0.03) reasons.push("High bounces");
    }
    return reasons;
  };

  const allSelected = filtered.length > 0 && filtered.every((d) => selectedDomains.has(d.domain));

  const toggleAll = () => {
    if (allSelected) setSelectedDomains(new Set());
    else setSelectedDomains(new Set(filtered.map((d) => d.domain)));
  };

  const toggleDomain = (domain: string) => {
    setSelectedDomains((prev) => {
      const next = new Set(prev);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });
  };

  const startBackgroundAttach = useCallback(async (campaigns: { id: number; name: string; instance: BisonInstanceSlug }[], domainsList: string[]) => {
    attachDomainsRef.current = domainsList;
    setSelectedDomains(new Set());
    for (const campaign of campaigns) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(`/api/deliverability/attach-domains-to-campaign?instance=${campaign.instance}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ campaign_id: campaign.id, domains: attachDomainsRef.current }),
          });
          if (res.ok) break;
        } catch { /* retry */ }
        if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }, []);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:!max-w-[90vw] lg:!max-w-[80vw] max-h-[85vh] flex flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle className="text-lg">{clientTag} — {domainStats.total} Domains</DialogTitle>
            <div className="flex gap-4 mt-2">
              {domainStats.outlookDomains > 0 && (
                <div className="flex items-center gap-1.5">
                  <div className="h-2 w-2 rounded-full bg-blue-400" />
                  <span className="text-xs text-muted-foreground">{domainStats.outlookDomains} Outlook domains · {domainStats.outlookInboxes} inboxes</span>
                </div>
              )}
              {domainStats.googleDomains > 0 && (
                <div className="flex items-center gap-1.5">
                  <div className="h-2 w-2 rounded-full bg-red-400" />
                  <span className="text-xs text-muted-foreground">{domainStats.googleDomains} Google domains · {domainStats.googleInboxes} inboxes</span>
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

          {/* Search */}
          <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-1.5 mt-2">
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <input
              value={domainSearch}
              onChange={(e) => setDomainSearch(e.target.value)}
              placeholder="Search domains..."
              className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
            />
            {domainSearch && <button onClick={() => setDomainSearch("")}><X className="h-3 w-3 text-muted-foreground hover:text-foreground" /></button>}
          </div>

          {/* Bulk action bar */}
          {selectedDomains.size > 0 && (
            <div className="flex items-center gap-3 rounded-xl border bg-muted/50 px-4 py-2.5 mt-1">
              <span className="text-xs font-medium">{selectedDomains.size} domain{selectedDomains.size !== 1 ? "s" : ""} selected</span>
              <div className="flex items-center gap-2 ml-auto">
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={() => setBulkTagMode("add")}>+ Add Tags</Button>
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={() => setShowAttachCampaigns(true)}>Attach to Campaigns</Button>
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5 text-amber-500 hover:text-amber-500" onClick={() => setShowRemoveFromCampaigns(true)}>Remove from Campaigns</Button>
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5 text-destructive hover:text-destructive" onClick={() => setBulkTagMode("remove")}>− Remove Tags</Button>
                <Button size="sm" variant="destructive" className="h-7 text-xs gap-1.5" onClick={() => setShowBulkDelete(true)}>Delete</Button>
                <div className="relative">
                  <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={(e) => { e.stopPropagation(); setShowExportMenu((v) => !v); }}>
                    <Download className="h-3 w-3" /> Export
                  </Button>
                  {showExportMenu && (
                    <div className="absolute top-full right-0 mt-1 z-50 rounded-lg border bg-popover shadow-md py-1 min-w-[160px]" onClick={(e) => e.stopPropagation()}>
                      <button onClick={copyDomainsToClipboard} className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-muted transition-colors">
                        <Copy className="h-3 w-3" /> {exportCopied ? "Copied!" : "Copy Domains"}
                      </button>
                      <button onClick={() => exportDomainsCsv(false)} className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-muted transition-colors">
                        <Download className="h-3 w-3" /> Download CSV
                      </button>
                      <button onClick={() => exportDomainsCsv(true)} className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-muted transition-colors">
                        <Download className="h-3 w-3" /> Download CSV (with stats)
                      </button>
                    </div>
                  )}
                </div>
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setSelectedDomains(new Set())}>Clear</Button>
              </div>
            </div>
          )}

          {/* Table */}
          {/* Background tag + campaign progress */}
          {tagCampaignJob && (
            <div className="rounded-lg border bg-muted/30 px-3 py-2 mt-1">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2 text-xs">
                  {(tagCampaignJob.tagStatus === "running" || !tagCampaignJob.campaignsDone) && <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />}
                  {tagCampaignJob.tagStatus !== "running" && tagCampaignJob.campaignsDone && <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />}
                  <span className="font-medium">{tagCampaignJob.tagStatus === "running" || !tagCampaignJob.campaignsDone ? "Processing..." : "Complete"}</span>
                </div>
                {tagCampaignJob.tagStatus !== "running" && tagCampaignJob.campaignsDone && (
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(tagCampaignJob.domains.join("\n"));
                        setDomainsCopied(true);
                        setTimeout(() => setDomainsCopied(false), 2000);
                      }}
                      className="text-[10px] text-primary hover:underline"
                    >
                      {domainsCopied ? "Copied!" : "Copy Domains"}
                    </button>
                    <button onClick={() => setTagCampaignJob(null)} className="text-[10px] text-muted-foreground hover:text-foreground">Dismiss</button>
                  </div>
                )}
              </div>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                <div className="flex items-center gap-2 text-xs">
                  {tagCampaignJob.tagStatus === "running" && <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />}
                  {tagCampaignJob.tagStatus === "done" && <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />}
                  {tagCampaignJob.tagStatus === "error" && <AlertTriangle className="h-3 w-3 text-destructive shrink-0" />}
                  <span className="text-muted-foreground">{tagCampaignJob.tagLabel}</span>
                  {tagCampaignJob.tagStatus === "done" && <span className="shrink-0 ml-auto text-emerald-500">{tagCampaignJob.tagAffected} inboxes</span>}
                  {tagCampaignJob.tagStatus === "error" && <span className="shrink-0 ml-auto text-destructive">{tagCampaignJob.tagError}</span>}
                </div>
                {tagCampaignJob.campaignJobs.map((job, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    {job.status === "running" && <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />}
                    {job.status === "done" && <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />}
                    {job.status === "error" && <AlertTriangle className="h-3 w-3 text-destructive shrink-0" />}
                    {job.status === "pending" && <div className="h-3 w-3 rounded-full border border-muted-foreground/30 shrink-0" />}
                    <span className="truncate text-muted-foreground">{job.campaign}</span>
                    {job.status === "done" && <span className="shrink-0 ml-auto text-emerald-500">+{job.newly} · {job.existing} existing</span>}
                    {job.status === "error" && <span className="shrink-0 ml-auto text-destructive">{job.error}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto rounded-lg border mt-1">
            <table className="w-full table-fixed">
              <thead className="sticky top-0 z-10">
                <tr className="bg-muted/50 border-b text-[11px] text-muted-foreground">
                  <th className="w-[32px] px-3 py-2.5">
                    <button
                      onClick={toggleAll}
                      className={`h-4 w-4 rounded border flex items-center justify-center transition-colors ${
                        allSelected ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30 hover:border-foreground"
                      }`}
                    >
                      {allSelected && <Check className="h-3 w-3" />}
                    </button>
                  </th>
                  <th className="text-left font-medium px-3 py-2.5 w-[25%]">Domain</th>
                  <th className="text-left font-medium px-3 py-2.5 w-[18%]">Tags</th>
                  <th className="text-center font-medium px-3 py-2.5 w-[8%]">Inboxes</th>
                  <th className="text-center font-medium px-3 py-2.5 w-[9%]">Sent</th>
                  <th className="text-center font-medium px-3 py-2.5 w-[9%]">Replied</th>
                  <th className="text-center font-medium px-3 py-2.5 w-[9%]">Bounced</th>
                  <th className="text-center font-medium px-3 py-2.5 w-[9%]">Warmup</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((d, domainIdx) => {
                  const flagReasons = getFlagReasons(d);
                  const isFlagged = flagReasons.length > 0;
                  const isSelected = selectedDomains.has(d.domain);
                  const totalSent = d.total_sent || 0;
                  const replyRate = totalSent > 0 ? ((d.total_replied || 0) / totalSent * 100).toFixed(1) : "0";
                  const bounceRate = totalSent > 0 ? ((d.total_bounced || 0) / totalSent * 100).toFixed(1) : "0";
                  const daysOld = d.domain_created_at ? Math.floor((now - new Date(d.domain_created_at).getTime()) / 86400000) : 0;
                  const warmupDaysLeft = Math.max(0, 21 - daysOld);

                  return (
                    <tr
                      key={d.domain}
                      onMouseEnter={() => handleDragEnter(domainIdx, filtered)}
                      className={`transition-colors cursor-pointer select-none ${
                        isSelected ? "bg-primary/5" : isFlagged ? "bg-destructive/5" : "hover:bg-muted/30"
                      }`}
                      onClick={() => toggleDomain(d.domain)}
                    >
                      <td className="px-3 py-3">
                        <div
                          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); handleDragStart(domainIdx, d.domain); }}
                          className={`h-4 w-4 rounded border flex items-center justify-center transition-colors ${
                            isSelected ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30"
                          }`}
                        >
                          {isSelected && <Check className="h-3 w-3" />}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          <span className="text-sm font-medium truncate">{d.domain}</span>
                          {isFlagged && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="shrink-0 cursor-help"><AlertTriangle className="h-3.5 w-3.5 text-destructive" /></span>
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
                          {d.tags?.slice(0, 3).map((t) => (
                            <span key={t} className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">{t}</span>
                          ))}
                          {d.tags && d.tags.length > 3 && <span className="text-[10px] text-muted-foreground">+{d.tags.length - 3}</span>}
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
                      <td className="text-center px-3 py-3">
                        {warmupDaysLeft > 0 ? (
                          <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30 text-[10px]">{warmupDaysLeft}d left</Badge>
                        ) : (
                          <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px]">Complete</Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </DialogContent>
      </Dialog>

      {/* Bulk Tag Dialog */}
      {bulkTagMode && (
        <BulkTagDialog
          mode={bulkTagMode}
          open={!!bulkTagMode}
          onOpenChange={(v) => { if (!v) setBulkTagMode(null); }}
          selectedDomains={Array.from(selectedDomains)}
          existingTags={(() => {
            const tagSet = new Set<string>();
            for (const d of domains) {
              if (selectedDomains.has(d.domain) && d.tags) d.tags.forEach((t) => tagSet.add(t));
            }
            return Array.from(tagSet);
          })()}
          availableTags={
            bulkTagMode === "remove"
              ? (() => {
                  const tagMap = new Map<string, { id: number; name: string }>();
                  for (const d of domains) {
                    if (selectedDomains.has(d.domain) && d.tags) {
                      for (const tagName of d.tags) {
                        if (!tagMap.has(tagName)) tagMap.set(tagName, { id: 0, name: tagName });
                      }
                    }
                  }
                  return Array.from(tagMap.values());
                })()
              : undefined
          }
          onApply={startBackgroundTagCampaign}
        />
      )}

      {/* Bulk Delete Dialog */}
      <BulkDeleteDialog
        open={showBulkDelete}
        onOpenChange={setShowBulkDelete}
        selectedDomains={domains
          .filter((d) => selectedDomains.has(d.domain))
          .map((d) => ({ domain: d.domain, inbox_count: d.inbox_count }))}
        // This page's domain list is default-instance-scoped (its fetch passes
        // no instances param) — scope the delete identically.
        instancesQuery={`instances=${DEFAULT_INSTANCE}`}
        onSuccess={() => {
          onDomainsChanged();
          setSelectedDomains(new Set());
        }}
      />

      {/* Attach to Campaigns Dialog */}
      <AttachToCampaignsDialog
        open={showAttachCampaigns}
        onOpenChange={setShowAttachCampaigns}
        selectedDomains={Array.from(selectedDomains)}
        onAttach={startBackgroundAttach}
      />

      {/* Remove from Campaigns Dialog */}
      <RemoveFromCampaignsDialog
        open={showRemoveFromCampaigns}
        onOpenChange={setShowRemoveFromCampaigns}
        selectedDomains={Array.from(selectedDomains)}
        onComplete={() => setSelectedDomains(new Set())}
      />
    </>
  );
}
