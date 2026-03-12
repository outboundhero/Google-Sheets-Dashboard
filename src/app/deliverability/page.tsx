"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  RefreshCw,
  Globe,
  Inbox,
  CheckCircle2,
  Clock,
  Filter,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/shared/page-header";
import { DomainAccordion } from "@/components/deliverability/domain-accordion";
import { Skeleton } from "@/components/ui/skeleton";

interface DomainRow {
  domain: string;
  inbox_count: number;
  domain_created_at: string | null;
  warmup_status: "open" | "done";
}

interface SyncProgress {
  synced: number;
  page: number;
  lastPage: number | null;
}

export default function DeliverabilityPage() {
  const [domains, setDomains] = useState<DomainRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [syncStats, setSyncStats] = useState<{ inboxCount: number; domainCount: number } | null>(null);
  const [tagFilter, setTagFilter] = useState<string>("");
  const [warmupFilter, setWarmupFilter] = useState<"all" | "open" | "done">("open");
  const [activeTab, setActiveTab] = useState<"inboxes" | "warmup">("inboxes");
  const [allTags, setAllTags] = useState<string[]>([]);
  const [savedPage, setSavedPage] = useState<number | null>(null);

  // Load saved sync progress from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem("deliverability_next_page");
    if (saved) setSavedPage(parseInt(saved, 10));
  }, []);

  const loadDomains = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/deliverability/domains");
      const data = await res.json();
      setDomains(Array.isArray(data) ? data : []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch("/api/deliverability/sync");
      const data = await res.json();
      setSyncStats(data);
    } catch {/* ignore */}
  }, []);

  const loadTags = useCallback(async () => {
    try {
      const res = await fetch("/api/deliverability/tags");
      const data = await res.json();
      if (Array.isArray(data)) setAllTags(data);
    } catch {/* ignore */}
  }, []);

  useEffect(() => {
    loadDomains();
    loadStats();
    loadTags();
  }, [loadDomains, loadStats, loadTags]);

  const handleSync = async (startFrom?: number) => {
    setSyncing(true);
    const resumePage = startFrom ?? savedPage ?? 1;
    setSyncProgress({ synced: 0, page: resumePage, lastPage: null });
    let nextPage: number | null = resumePage as number | null;
    let totalSynced = 0;

    try {
      while (nextPage !== null) {
        // Save progress so user can resume if they close/refresh
        localStorage.setItem("deliverability_next_page", String(nextPage));
        setSavedPage(nextPage);

        const res = await fetch("/api/deliverability/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ startPage: nextPage, pagesPerChunk: 20 }),
        });
        if (!res.ok) break;
        const result = await res.json();
        totalSynced += result.synced || 0;
        setSyncProgress({
          synced: totalSynced,
          page: result.nextPage || result.lastPage,
          lastPage: result.lastPage,
        });
        nextPage = result.complete ? null : result.nextPage;
        if (!result.complete) {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      // Sync complete — clear saved progress
      localStorage.removeItem("deliverability_next_page");
      setSavedPage(null);
      await loadDomains();
      await loadStats();
      await loadTags();
    } finally {
      setSyncing(false);
      setSyncProgress(null);
    }
  };

  const handleWarmupStatusChange = async (domain: string, status: "open" | "done") => {
    await fetch(`/api/deliverability/domains/${encodeURIComponent(domain)}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ warmup_status: status }),
    });
    setDomains((prev) =>
      prev.map((d) => (d.domain === domain ? { ...d, warmup_status: status } : d))
    );
  };

  // Compute warmup-eligible domains (21+ days old)
  const now = Date.now();
  const warmupDomains = useMemo(
    () =>
      domains
        .map((d) => {
          const daysOld = d.domain_created_at
            ? Math.floor((now - new Date(d.domain_created_at).getTime()) / (1000 * 60 * 60 * 24))
            : 0;
          return { ...d, daysOld, warmupComplete: daysOld >= 21 };
        })
        .filter((d) => d.warmupComplete)
        .filter((d) => warmupFilter === "all" || d.warmup_status === warmupFilter),
    [domains, warmupFilter, now]
  );

  const filteredDomains = tagFilter
    ? domains // tag filter is applied inside DomainAccordion via API
    : domains;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Deliverability"
        description={
          syncStats
            ? `${syncStats.inboxCount?.toLocaleString() ?? 0} inboxes across ${syncStats.domainCount?.toLocaleString() ?? 0} domains`
            : "Manage your sender inboxes and email warmup"
        }
      >
        <div className="flex items-center gap-2">
          {savedPage && savedPage > 1 && !syncing && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { localStorage.removeItem("deliverability_next_page"); setSavedPage(null); }}
              className="text-xs text-muted-foreground gap-1"
            >
              <X className="h-3 w-3" /> Reset
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleSync()}
            disabled={syncing}
            className="gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing…" : savedPage && savedPage > 1 ? `Resume (page ${savedPage.toLocaleString()})` : "Sync Inboxes"}
          </Button>
        </div>
      </PageHeader>

      {/* Sync Progress */}
      {syncProgress && (
        <div className="rounded-lg border bg-muted/30 px-4 py-3 flex items-center gap-3 text-sm">
          <RefreshCw className="h-4 w-4 animate-spin text-primary" />
          <span>
            Syncing page {syncProgress.page}
            {syncProgress.lastPage ? ` of ${syncProgress.lastPage}` : ""}
            {" — "}
            {syncProgress.synced.toLocaleString()} inboxes synced so far
          </span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b">
        <button
          onClick={() => setActiveTab("inboxes")}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "inboxes"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <Inbox className="inline h-4 w-4 mr-1.5" />
          Inboxes by Domain
        </button>
        <button
          onClick={() => setActiveTab("warmup")}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "warmup"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <Clock className="inline h-4 w-4 mr-1.5" />
          Warmup Status
          {warmupDomains.filter((d) => d.warmup_status === "open").length > 0 && (
            <Badge variant="destructive" className="ml-1.5 text-xs px-1.5 py-0">
              {warmupDomains.filter((d) => d.warmup_status === "open").length}
            </Badge>
          )}
        </button>
      </div>

      {/* INBOXES TAB */}
      {activeTab === "inboxes" && (
        <div className="space-y-4">
          {/* Tag Filter */}
          <div className="flex items-center gap-2 flex-wrap">
            <Filter className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-sm text-muted-foreground shrink-0">Filter by tag:</span>
            <button
              onClick={() => setTagFilter("")}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                tagFilter === ""
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
              }`}
            >
              All
            </button>
            {allTags.length === 0 && !loading ? (
              <span className="text-xs text-muted-foreground italic">No tags found — sync inboxes first</span>
            ) : (
              allTags.map((tag) => (
                <button
                  key={tag}
                  onClick={() => setTagFilter(tagFilter === tag ? "" : tag)}
                  className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                    tagFilter === tag
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                  }`}
                >
                  {tag}
                  {tagFilter === tag && <X className="inline h-3 w-3 ml-1" />}
                </button>
              ))
            )}
          </div>

          {/* Domain Accordions */}
          {loading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-14 rounded-xl" />
              ))}
            </div>
          ) : filteredDomains.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Globe className="h-10 w-10 text-muted-foreground mb-3" />
              <h3 className="font-medium">No inboxes synced yet</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Click "Sync Inboxes" to fetch your sender emails
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredDomains.map((domain, i) => (
                <DomainAccordion
                  key={domain.domain}
                  domain={domain}
                  defaultOpen={i < 3}
                  tagFilter={tagFilter || undefined}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* WARMUP TAB */}
      {activeTab === "warmup" && (
        <div className="space-y-4">
          {/* Warmup Filter */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Show:</span>
            {(["open", "done", "all"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setWarmupFilter(f)}
                className={`text-xs px-3 py-1.5 rounded-full border capitalize transition-colors ${
                  warmupFilter === f
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                }`}
              >
                {f === "open" ? "🔵 Open" : f === "done" ? "✅ Done" : "All"}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="space-y-2">
              {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}
            </div>
          ) : warmupDomains.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Clock className="h-10 w-10 text-muted-foreground mb-3" />
              <h3 className="font-medium">
                {warmupFilter === "done"
                  ? "No completed warmups marked as done"
                  : "No domains have completed 3 weeks of warmup yet"}
              </h3>
              <p className="text-sm text-muted-foreground mt-1">
                Domains need 21 days from creation to complete warmup
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {warmupDomains.map((d) => (
                <div
                  key={d.domain}
                  className="flex items-center gap-4 rounded-xl border bg-card px-4 py-3.5"
                >
                  <CheckCircle2 className="h-5 w-5 text-green-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm">{d.domain}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      Added {new Date(d.domain_created_at!).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                      {" · "}
                      {d.daysOld} days old
                      {" · "}
                      {d.inbox_count} inbox{d.inbox_count !== 1 ? "es" : ""}
                    </div>
                  </div>
                  {/* Open / Done toggle */}
                  <div className="flex items-center gap-1 rounded-lg border bg-muted p-0.5 flex-shrink-0">
                    <button
                      onClick={() => handleWarmupStatusChange(d.domain, "open")}
                      className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                        d.warmup_status === "open"
                          ? "bg-background shadow text-foreground font-medium"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      Open
                    </button>
                    <button
                      onClick={() => handleWarmupStatusChange(d.domain, "done")}
                      className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                        d.warmup_status === "done"
                          ? "bg-background shadow text-foreground font-medium"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      Done
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
