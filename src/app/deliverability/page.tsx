"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  RefreshCw,
  Globe,
  Inbox,
  CheckCircle2,
  Clock,
  ChevronDown,
  Search,
  X,
  Check,
  Link2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/shared/page-header";
import { DomainAccordion } from "@/components/deliverability/domain-accordion";
import { AttachCampaignsDialog } from "@/components/deliverability/attach-campaigns-dialog";
import { Skeleton } from "@/components/ui/skeleton";

interface DomainRow {
  domain: string;
  inbox_count: number;
  domain_created_at: string | null;
  warmup_status: "open" | "done";
  tags?: string[];
}

interface SyncProgress {
  synced: number;
  page: number;
  lastPage: number | null;
}

// ---------- Tag Multi-Select Dropdown ----------
function TagFilterDropdown({
  allTags,
  selected,
  onChange,
}: {
  allTags: string[];
  selected: string[];
  onChange: (tags: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered = useMemo(
    () => allTags.filter((t) => t.toLowerCase().includes(search.toLowerCase())),
    [allTags, search]
  );

  const toggle = (tag: string) => {
    onChange(selected.includes(tag) ? selected.filter((t) => t !== tag) : [...selected, tag]);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border transition-colors ${
          selected.length > 0
            ? "border-primary bg-primary/10 text-primary"
            : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
        }`}
      >
        <span>Tags</span>
        {selected.length > 0 && (
          <span className="bg-primary text-primary-foreground text-xs font-medium rounded-full w-5 h-5 flex items-center justify-center">
            {selected.length}
          </span>
        )}
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1.5 z-50 w-64 rounded-xl border bg-popover shadow-lg overflow-hidden">
          {/* Search */}
          <div className="flex items-center gap-2 px-3 py-2 border-b">
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tags…"
              className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
            />
            {search && (
              <button onClick={() => setSearch("")}>
                <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
              </button>
            )}
          </div>

          {/* Clear all */}
          {selected.length > 0 && (
            <button
              onClick={() => { onChange([]); }}
              className="w-full text-left px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent border-b"
            >
              Clear all ({selected.length} selected)
            </button>
          )}

          {/* Tag list */}
          <div className="max-h-64 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground text-center">No tags found</div>
            ) : (
              filtered.map((tag) => (
                <button
                  key={tag}
                  onClick={() => toggle(tag)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left transition-colors"
                >
                  <div className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                    selected.includes(tag) ? "bg-primary border-primary" : "border-border"
                  }`}>
                    {selected.includes(tag) && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                  </div>
                  <span className="truncate">{tag}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
// ------------------------------------------------

export default function DeliverabilityPage() {
  const [domains, setDomains] = useState<DomainRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [syncStats, setSyncStats] = useState<{ inboxCount: number; domainCount: number } | null>(null);
  const [tagFilters, setTagFilters] = useState<string[]>([]);
  const [warmupFilter, setWarmupFilter] = useState<"all" | "open" | "done">("open");
  const [activeTab, setActiveTab] = useState<"inboxes" | "warmup">("inboxes");
  const [allTags, setAllTags] = useState<string[]>([]);
  const [savedPage, setSavedPage] = useState<number | null>(null);
  const [domainSearch, setDomainSearch] = useState("");
  const [warmupSearch, setWarmupSearch] = useState("");
  const [attachDialogOpen, setAttachDialogOpen] = useState(false);

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
    } catch { /* ignore */ } finally {
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

  const handleSync = async () => {
    setSyncing(true);
    const resumePage = savedPage ?? 1;
    setSyncProgress({ synced: 0, page: resumePage, lastPage: null });
    let nextPage: number | null = resumePage as number | null;
    let totalSynced = 0;

    try {
      while (nextPage !== null) {
        localStorage.setItem("deliverability_next_page", String(nextPage));
        setSavedPage(nextPage);

        const res = await fetch("/api/deliverability/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ startPage: nextPage, pagesPerChunk: 50 }),
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
        if (!result.complete) await new Promise((r) => setTimeout(r, 300));
      }
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
        .filter((d) => warmupFilter === "all" || d.warmup_status === warmupFilter)
        .filter((d) =>
          warmupSearch ? d.domain.toLowerCase().includes(warmupSearch.toLowerCase()) : true
        ),
    [domains, warmupFilter, warmupSearch, now]
  );

  // Client-side filter: tag match (OR) + domain search
  const filteredDomains = useMemo(() => {
    let result = domains;
    if (tagFilters.length > 0) {
      result = result.filter((d) =>
        d.tags && tagFilters.some((tag) => d.tags!.includes(tag))
      );
    }
    if (domainSearch) {
      result = result.filter((d) =>
        d.domain.toLowerCase().includes(domainSearch.toLowerCase())
      );
    }
    return result;
  }, [domains, tagFilters, domainSearch]);

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
            onClick={() => setAttachDialogOpen(true)}
            className="gap-2"
          >
            <Link2 className="h-4 w-4" />
            Attach to Campaigns
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleSync}
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
        <div className="space-y-3">
          {/* Search + Tag Filter row */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Search */}
            <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-1.5 flex-1 min-w-[200px] max-w-xs">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input
                value={domainSearch}
                onChange={(e) => setDomainSearch(e.target.value)}
                placeholder="Search domains or inboxes…"
                className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
              />
              {domainSearch && (
                <button onClick={() => setDomainSearch("")}>
                  <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                </button>
              )}
            </div>

            {/* Tag multi-select */}
            <TagFilterDropdown
              allTags={allTags}
              selected={tagFilters}
              onChange={setTagFilters}
            />

            {/* Active tag chips */}
            {tagFilters.map((tag) => (
              <span
                key={tag}
                className="flex items-center gap-1 text-xs bg-primary/10 text-primary border border-primary/20 rounded-full px-2.5 py-1"
              >
                {tag}
                <button onClick={() => setTagFilters((prev) => prev.filter((t) => t !== tag))}>
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}

            {(tagFilters.length > 0 || domainSearch) && (
              <span className="text-xs text-muted-foreground">
                {filteredDomains.length} domain{filteredDomains.length !== 1 ? "s" : ""}
              </span>
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
              <h3 className="font-medium">
                {domains.length === 0 ? "No inboxes synced yet" : "No domains match your filters"}
              </h3>
              <p className="text-sm text-muted-foreground mt-1">
                {domains.length === 0
                  ? 'Click "Sync Inboxes" to fetch your sender emails'
                  : "Try adjusting your search or tag filters"}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredDomains.map((domain, i) => (
                <DomainAccordion
                  key={domain.domain}
                  domain={domain}
                  defaultOpen={i < 3}
                  tagFilters={tagFilters.length > 0 ? tagFilters : undefined}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* WARMUP TAB */}
      {activeTab === "warmup" && (
        <div className="space-y-3">
          {/* Search + filter row */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-1.5 flex-1 min-w-[200px] max-w-xs">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input
                value={warmupSearch}
                onChange={(e) => setWarmupSearch(e.target.value)}
                placeholder="Search domains…"
                className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
              />
              {warmupSearch && (
                <button onClick={() => setWarmupSearch("")}>
                  <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                </button>
              )}
            </div>

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
                  : warmupSearch
                  ? "No domains match your search"
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
                      Added{" "}
                      {new Date(d.domain_created_at!).toLocaleDateString("en-US", {
                        month: "short", day: "numeric", year: "numeric",
                      })}
                      {" · "}{d.daysOld} days old
                      {" · "}{d.inbox_count} inbox{d.inbox_count !== 1 ? "es" : ""}
                    </div>
                    {d.tags && d.tags.length > 0 && (
                      <div className="flex gap-1 flex-wrap mt-1">
                        {d.tags.slice(0, 5).map((t) => (
                          <span key={t} className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">{t}</span>
                        ))}
                        {d.tags.length > 5 && (
                          <span className="text-[10px] text-muted-foreground">+{d.tags.length - 5}</span>
                        )}
                      </div>
                    )}
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

      {/* Attach Campaigns Dialog */}
      <AttachCampaignsDialog open={attachDialogOpen} onOpenChange={setAttachDialogOpen} />
    </div>
  );
}
