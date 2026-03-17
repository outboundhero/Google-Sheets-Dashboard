"use client";

import { useState, useEffect, useCallback, useMemo, useRef, type MutableRefObject } from "react";
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
  Send,
  Reply,
  AlertTriangle,
  Mail,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/shared/page-header";
import { AttachCampaignsDialog } from "@/components/deliverability/attach-campaigns-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

interface DomainRow {
  domain: string;
  inbox_count: number;
  domain_created_at: string | null;
  warmup_status: "open" | "done";
  tags?: string[];
  total_sent?: number;
  total_replied?: number;
  total_bounced?: number;
  outlook_count?: number;
  google_count?: number;
}

interface SyncProgress {
  synced: number;
  page: number;
  lastPage: number | null;
  streams?: number;
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
  const [typeFilter, setTypeFilter] = useState<"all" | "outlook" | "google">("all");
  const [showFlagged, setShowFlagged] = useState(false);
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

  // Use ref for progress so parallel stream closures always see latest values
  const progressRef = useRef({ synced: 0, pagesProcessed: 0, lastPage: 0 });

  const handleSync = async () => {
    setSyncing(true);
    const CHUNK = 50;
    const STREAMS = 4;
    progressRef.current = { synced: 0, pagesProcessed: 0, lastPage: 0 };

    const flushProgress = () => {
      const p = progressRef.current;
      setSyncProgress({
        synced: p.synced,
        page: p.pagesProcessed,
        lastPage: p.lastPage,
        streams: STREAMS,
      });
    };

    // Single stream worker
    const runStream = async (start: number, end: number) => {
      let page = start;
      while (page <= end) {
        const res = await fetch("/api/deliverability/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ startPage: page, pagesPerChunk: CHUNK }),
        });
        if (!res.ok) break;
        const result = await res.json();
        const pagesInChunk = Math.min(CHUNK, end - page + 1);
        progressRef.current.synced += result.synced || 0;
        progressRef.current.pagesProcessed += pagesInChunk;
        flushProgress();
        page += CHUNK;
      }
    };

    try {
      // First fetch to discover lastPage
      const resumeFrom = savedPage ?? 1;
      const firstRes = await fetch("/api/deliverability/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startPage: resumeFrom, pagesPerChunk: CHUNK }),
      });
      if (!firstRes.ok) { setSyncing(false); return; }
      const firstResult = await firstRes.json();
      const lastPage = firstResult.lastPage || 1;
      progressRef.current = {
        synced: firstResult.synced || 0,
        pagesProcessed: CHUNK,
        lastPage: lastPage - resumeFrom + 1,
      };
      flushProgress();

      const startAfterFirst = resumeFrom + CHUNK;
      const totalPages = lastPage - resumeFrom + 1;
      progressRef.current.lastPage = totalPages;
      const remaining = lastPage - startAfterFirst + 1;

      if (remaining > 0) {
        const perStream = Math.ceil(remaining / STREAMS);
        const ranges = Array.from({ length: STREAMS }, (_, i) => ({
          start: startAfterFirst + i * perStream,
          end: Math.min(startAfterFirst + (i + 1) * perStream - 1, lastPage),
        })).filter((r) => r.start <= lastPage);

        // Save progress for resume
        localStorage.setItem("deliverability_next_page", String(startAfterFirst));
        setSavedPage(startAfterFirst);

        await Promise.all(ranges.map((r) => runStream(r.start, r.end)));
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

  // Flag computation helper — returns human-readable reason strings
  const getFlagReasons = useCallback((d: DomainRow): string[] => {
    const reasons: string[] = [];
    const isGoogle = (d.google_count || 0) > 0 && (d.outlook_count || 0) === 0;
    const isOutlook = (d.outlook_count || 0) > 0 && (d.google_count || 0) === 0;
    if (!(isGoogle || isOutlook) || (d.total_sent || 0) <= 100) return reasons;

    const replied = d.total_replied || 0;
    const bounced = d.total_bounced || 0;
    const sent = (d.total_sent || 0).toLocaleString();
    const lowReplyThreshold = isGoogle ? 2 : 16;
    const highBounceThreshold = isGoogle ? 20 : 170;

    if (replied <= lowReplyThreshold) {
      reasons.push(`Low replies (${replied} with ${sent} sent)`);
    }
    if (bounced > highBounceThreshold) {
      reasons.push(`High bounces (${bounced.toLocaleString()} with ${sent} sent)`);
    }
    return reasons;
  }, []);

  const isDomainFlagged = useCallback((d: DomainRow) => getFlagReasons(d).length > 0, [getFlagReasons]);

  // Client-side filter: tag match (OR) + domain search + type filter + flagged
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
    if (typeFilter === "outlook") {
      result = result.filter((d) => (d.outlook_count || 0) > 0);
    } else if (typeFilter === "google") {
      result = result.filter((d) => (d.google_count || 0) > 0);
    }
    if (showFlagged) {
      result = result.filter((d) => isDomainFlagged(d));
    }
    return result;
  }, [domains, tagFilters, domainSearch, typeFilter, showFlagged, isDomainFlagged]);

  const flaggedCount = useMemo(() => domains.filter(isDomainFlagged).length, [domains, isDomainFlagged]);

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
        <div className="rounded-lg border bg-muted/30 px-4 py-3 space-y-2">
          <div className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-3">
              <RefreshCw className="h-4 w-4 animate-spin text-primary" />
              <span>
                {syncProgress.synced.toLocaleString()} inboxes synced
                {syncProgress.streams && syncProgress.streams > 1
                  ? ` — ${syncProgress.streams} parallel streams`
                  : ""}
              </span>
            </div>
            {syncProgress.lastPage && syncProgress.lastPage > 0 && (
              <span className="text-muted-foreground">
                {syncProgress.page.toLocaleString()} / {syncProgress.lastPage.toLocaleString()} pages
                {" "}({Math.round((syncProgress.page / syncProgress.lastPage) * 100)}%)
              </span>
            )}
          </div>
          {syncProgress.lastPage && syncProgress.lastPage > 0 && (
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-primary transition-all duration-300"
                style={{
                  width: `${Math.min(100, (syncProgress.page / syncProgress.lastPage) * 100)}%`,
                }}
              />
            </div>
          )}
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
          {/* Search + Filters row */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Search */}
            <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-1.5 flex-1 min-w-[200px] max-w-xs">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input
                value={domainSearch}
                onChange={(e) => setDomainSearch(e.target.value)}
                placeholder="Search domains…"
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

            {/* Type filter */}
            {(["all", "outlook", "google"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTypeFilter(t)}
                className={`text-xs px-3 py-1.5 rounded-full border capitalize transition-colors ${
                  typeFilter === t
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                }`}
              >
                {t === "all" ? "All Types" : t === "outlook" ? "Outlook" : "Google"}
              </button>
            ))}

            {/* Flagged filter */}
            <button
              onClick={() => setShowFlagged((v) => !v)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors flex items-center gap-1.5 ${
                showFlagged
                  ? "bg-destructive text-destructive-foreground border-destructive"
                  : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
              }`}
            >
              <AlertTriangle className="h-3 w-3" />
              Flagged
              {flaggedCount > 0 && (
                <span className={`text-[10px] font-medium rounded-full px-1.5 ${
                  showFlagged ? "bg-destructive-foreground/20" : "bg-destructive/15 text-destructive"
                }`}>
                  {flaggedCount}
                </span>
              )}
            </button>

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

            {(tagFilters.length > 0 || domainSearch || typeFilter !== "all") && (
              <span className="text-xs text-muted-foreground">
                {filteredDomains.length} domain{filteredDomains.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>

          {/* Domain Stats List */}
          {loading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-16 rounded-xl" />
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
            <div className="space-y-1.5">
              {/* Table header */}
              <div className="grid grid-cols-[1fr_100px_80px_80px_80px_100px] gap-3 px-4 py-2 text-xs text-muted-foreground font-medium">
                <span>Domain</span>
                <span className="text-center">Inboxes</span>
                <span className="text-center">Sent</span>
                <span className="text-center">Replied</span>
                <span className="text-center">Bounced</span>
                <span className="text-center">Warmup</span>
              </div>
              {filteredDomains.map((d) => {
                const daysOld = d.domain_created_at
                  ? Math.floor((now - new Date(d.domain_created_at).getTime()) / (1000 * 60 * 60 * 24))
                  : 0;
                const warmupDaysLeft = Math.max(0, 21 - daysOld);
                const replyRate = (d.total_sent || 0) > 0
                  ? ((d.total_replied || 0) / (d.total_sent || 1) * 100).toFixed(1)
                  : "0.0";

                // Flagging rules
                const isGoogleDomain = (d.google_count || 0) > 0 && (d.outlook_count || 0) === 0;
                const isOutlookDomain = (d.outlook_count || 0) > 0 && (d.google_count || 0) === 0;
                const flagReasons = getFlagReasons(d);
                const flagged = flagReasons.length > 0;

                return (
                  <div
                    key={d.domain}
                    className={`grid grid-cols-[1fr_100px_80px_80px_80px_100px] gap-3 items-center rounded-xl border px-4 py-3 transition-colors ${
                      flagged
                        ? "bg-destructive/5 border-destructive/30 hover:bg-destructive/10"
                        : "bg-card hover:bg-muted/30"
                    }`}
                  >
                    {/* Domain info */}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="font-medium text-sm truncate">{d.domain}</span>
                        {flagged && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="shrink-0 cursor-help">
                                <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                              </span>
                            </TooltipTrigger>
                            <TooltipContent
                              side="right"
                              sideOffset={6}
                              className="bg-destructive/95 text-destructive-foreground border-destructive/50 max-w-xs"
                            >
                              <div className="space-y-0.5">
                                {flagReasons.map((reason, i) => (
                                  <div key={i} className="text-xs">{reason}</div>
                                ))}
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 mt-1 ml-5">
                        {d.tags && d.tags.slice(0, 3).map((t) => (
                          <span key={t} className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">{t}</span>
                        ))}
                        {d.tags && d.tags.length > 3 && (
                          <span className="text-[10px] text-muted-foreground">+{d.tags.length - 3}</span>
                        )}
                      </div>
                    </div>

                    {/* Inbox counts */}
                    <div className="text-center text-sm">
                      <span className="font-medium">{d.inbox_count}</span>
                      {((d.outlook_count || 0) > 0 || (d.google_count || 0) > 0) && (
                        <div className="flex items-center justify-center gap-1.5 mt-0.5">
                          {(d.outlook_count || 0) > 0 && (
                            <span className="text-[10px] text-blue-400">{d.outlook_count} OL</span>
                          )}
                          {(d.google_count || 0) > 0 && (
                            <span className="text-[10px] text-red-400">{d.google_count} G</span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Sent */}
                    <div className="text-center text-sm font-medium">
                      {(d.total_sent || 0).toLocaleString()}
                    </div>

                    {/* Replied */}
                    <div className="text-center">
                      <div className={`text-sm font-medium ${
                        (isGoogleDomain && (d.total_replied || 0) <= 2) || (isOutlookDomain && (d.total_replied || 0) <= 16)
                          ? "text-destructive" : ""
                      }`}>{(d.total_replied || 0).toLocaleString()}</div>
                      <div className="text-[10px] text-muted-foreground">{replyRate}%</div>
                    </div>

                    {/* Bounced */}
                    <div className={`text-center text-sm font-medium ${
                      (isGoogleDomain && (d.total_bounced || 0) > 20) || (isOutlookDomain && (d.total_bounced || 0) > 170)
                        ? "text-destructive" : ""
                    }`}>
                      {(d.total_bounced || 0).toLocaleString()}
                    </div>

                    {/* Warmup status */}
                    <div className="text-center">
                      {warmupDaysLeft > 0 ? (
                        <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30 text-[10px]">
                          {warmupDaysLeft}d left
                        </Badge>
                      ) : d.warmup_status === "done" ? (
                        <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px]">
                          Done
                        </Badge>
                      ) : (
                        <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px]">
                          Complete
                        </Badge>
                      )}
                    </div>
                  </div>
                );
              })}
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
