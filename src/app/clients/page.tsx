"use client";

import { useState, useMemo } from "react";
import { Search } from "lucide-react";
import { useAllLeads } from "@/lib/hooks/use-leads";
import { useSheets } from "@/lib/hooks/use-sheets";
import { PageHeader } from "@/components/shared/page-header";
import { ClientCard } from "@/components/clients/client-card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

export default function ClientsPage() {
  const { leads, isLoading } = useAllLeads();
  const { sheets } = useSheets();
  const [search, setSearch] = useState("");

  const clientStats = useMemo(() => {
    // Group by clientTag — merges multiple sheets for the same client
    const map = new Map<
      string,
      {
        clientTag: string;
        totalLeads: number;
        qualityLeads: number;
      }
    >();

    // Initialize from sheets so we see clients even with 0 leads
    for (const sheet of sheets) {
      const tag = sheet.clientTag?.trim() || "";
      // Skip emails and invalid tags
      if (!tag || tag.includes("@")) continue;

      if (!map.has(tag)) {
        map.set(tag, {
          clientTag: tag,
          totalLeads: 0,
          qualityLeads: 0,
        });
      }
    }

    // Aggregate leads by clientTag (skip leads with no tag or invalid tags)
    // Filter out common category values that might be in clientTag field
    const invalidClientTags = [
      "meeting-ready", "meeting ready", "interested", "not interested",
      "lead", "quality lead", "not a quality lead", "undetermined",
      "duplicated", "duplicate", "lead not received", ""
    ];

    for (const lead of leads) {
      const tag = lead.clientTag?.trim() || "";

      // Skip if empty, invalid, or looks like an email address
      if (!tag || invalidClientTags.includes(tag.toLowerCase()) || tag.includes("@")) {
        continue;
      }

      let entry = map.get(tag);
      if (!entry) {
        entry = { clientTag: tag, totalLeads: 0, qualityLeads: 0 };
        map.set(tag, entry);
      }
      entry.totalLeads++;
      const status = lead.status.trim().toLowerCase();
      if (status === "quality lead") entry.qualityLeads++;
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
        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search clients..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
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
            <ClientCard key={client.clientTag} {...client} />
          ))}
        </div>
      )}
    </div>
  );
}
