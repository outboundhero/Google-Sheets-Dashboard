"use client";

import { useState, useMemo, useEffect } from "react";
import { Search } from "lucide-react";
import { useAllLeads } from "@/lib/hooks/use-leads";
import { useSheets } from "@/lib/hooks/use-sheets";
import { PageHeader } from "@/components/shared/page-header";
import { ClientCard } from "@/components/clients/client-card";
import { RefreshButton } from "@/components/shared/refresh-button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

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

function isDomainFlagged(d: DomainRow): boolean {
  const isGoogle = (d.google_count || 0) > 0 && (d.outlook_count || 0) === 0;
  const isOutlook = (d.outlook_count || 0) > 0 && (d.google_count || 0) === 0;
  if (!(isGoogle || isOutlook) || (d.total_sent || 0) <= 100) return false;
  const replied = d.total_replied || 0;
  const bounced = d.total_bounced || 0;
  const lowReply = isGoogle ? 2 : 16;
  const highBounce = isGoogle ? 20 : 170;
  return replied <= lowReply || bounced > highBounce;
}

export default function ClientsPage() {
  const { leads, isLoading, isSyncing, syncProgress, refresh } = useAllLeads();
  const { sheets } = useSheets();
  const [search, setSearch] = useState("");
  const [deliverabilityDomains, setDeliverabilityDomains] = useState<DomainRow[]>([]);

  useEffect(() => {
    fetch("/api/deliverability/domains")
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setDeliverabilityDomains(data); })
      .catch(() => {});
  }, []);

  // Compute flagged domain counts per client tag
  const flaggedByTag = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of deliverabilityDomains) {
      if (!isDomainFlagged(d)) continue;
      if (!d.tags || d.tags.length === 0) continue;
      for (const tag of d.tags) {
        map.set(tag, (map.get(tag) || 0) + 1);
      }
    }
    return map;
  }, [deliverabilityDomains]);

  const clientStats = useMemo(() => {
    // Invalid patterns - check if client tag contains or equals these
    const invalidPatterns = [
      "meeting-ready", "meeting ready", "meeting",
      "interested", "not interested",
      "quality lead", "not a quality lead", "undetermined",
      "duplicated", "duplicate", "lead not received"
    ];

    // Helper to check if a tag is invalid
    const isInvalidTag = (tag: string): boolean => {
      const lower = tag.toLowerCase().trim();
      if (!lower) return true;
      if (lower.includes("@")) return true;

      // Check if tag is exactly "lead" or contains any invalid pattern
      if (lower === "lead") return true;

      // Check if tag contains any invalid pattern
      return invalidPatterns.some(pattern => {
        // For "meeting", only invalid if it's the whole word or at the start
        if (pattern === "meeting") {
          return lower === "meeting" || lower.startsWith("meeting-") || lower.startsWith("meeting ");
        }
        return lower.includes(pattern);
      });
    };

    // Group by clientTag — merges multiple sheets for the same client
    const map = new Map<
      string,
      {
        clientTag: string;
        totalLeads: number;
        qualityLeads: number;
        meetingReadyLast24h: number;
        meetingReadyWithoutStatus: number;
      }
    >();

    // PST timezone calculation
    const now = new Date();
    const pstOffset = -8 * 60;
    const nowPst = new Date(now.getTime() + (pstOffset + now.getTimezoneOffset()) * 60000);
    const twentyFourHoursAgoPst = new Date(nowPst.getTime() - 24 * 60 * 60 * 1000);

    // Initialize from sheets so we see clients even with 0 leads
    for (const sheet of sheets) {
      const tag = sheet.clientTag?.trim() || "";
      // Skip invalid tags
      if (isInvalidTag(tag)) continue;

      if (!map.has(tag)) {
        map.set(tag, {
          clientTag: tag,
          totalLeads: 0,
          qualityLeads: 0,
          meetingReadyLast24h: 0,
          meetingReadyWithoutStatus: 0,
        });
      }
    }

    // Helper to parse dates
    const parseDate = (dateStr: string): Date | null => {
      if (!dateStr) return null;
      const d = new Date(dateStr);
      return isNaN(d.getTime()) ? null : d;
    };

    for (const lead of leads) {
      // Use sheetClientTag for grouping (from TrackedSheet config)
      const tag = lead.sheetClientTag?.trim() || "";

      // Skip if invalid tag
      if (isInvalidTag(tag)) {
        continue;
      }

      let entry = map.get(tag);
      if (!entry) {
        entry = {
          clientTag: tag,
          totalLeads: 0,
          qualityLeads: 0,
          meetingReadyLast24h: 0,
          meetingReadyWithoutStatus: 0,
        };
        map.set(tag, entry);
      }

      entry.totalLeads++;
      const status = lead.status.trim().toLowerCase();
      if (status === "quality lead") entry.qualityLeads++;

      // Check if meeting-ready in last 24h
      if (lead.currentCategory.toLowerCase().includes("meeting")) {
        const replyDate = parseDate(lead.timeWeGotReply) || parseDate(lead.replyTime);
        if (replyDate) {
          const replyPst = new Date(replyDate.getTime() + (pstOffset + replyDate.getTimezoneOffset()) * 60000);
          if (replyPst >= twentyFourHoursAgoPst) {
            entry.meetingReadyLast24h++;
          }
        }

        // Check if meeting-ready without status
        if (!lead.status.trim()) {
          entry.meetingReadyWithoutStatus++;
        }
      }
    }

    return Array.from(map.values())
      .map((c) => ({
        ...c,
        qualityPercentage:
          c.totalLeads > 0
            ? Math.round((c.qualityLeads / c.totalLeads) * 100)
            : 0,
      }))
      .sort((a, b) => b.totalLeads - a.totalLeads);
  }, [leads, sheets]);

  // Count unique clientTags
  const uniqueClients = new Set(sheets.map((s) => s.clientTag)).size;

  const filtered = search
    ? clientStats.filter((c) =>
        c.clientTag.toLowerCase().includes(search.toLowerCase())
      )
    : clientStats;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Clients"
        description={`${uniqueClients} tracked client${uniqueClients !== 1 ? "s" : ""}`}
      >
        <div className="flex items-center gap-3">
          <RefreshButton onRefresh={refresh} isRefreshing={isSyncing} syncProgress={syncProgress} />
          <div className="relative w-64">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search clients..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>
      </PageHeader>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20">
          <p className="text-muted-foreground">
            {sheets.length === 0
              ? "No clients tracked yet. Add sheets in Settings."
              : "No clients match your search."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((client) => (
            <ClientCard key={client.clientTag} {...client} flaggedDomains={flaggedByTag.get(client.clientTag) ?? 0} />
          ))}
        </div>
      )}
    </div>
  );
}
