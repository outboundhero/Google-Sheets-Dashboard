"use client";

import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
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
  Loader2,
  Download,
  Copy,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/shared/page-header";
import { AttachCampaignsDialog } from "@/components/deliverability/attach-campaigns-dialog";
import { BulkTagDialog, type TagApplyInfo } from "@/components/deliverability/bulk-tag-dialog";
import { BulkDeleteDialog } from "@/components/deliverability/bulk-delete-dialog";
import { AttachToCampaignsDialog } from "@/components/deliverability/attach-to-campaigns-dialog";
import { RemoveFromCampaignsDialog } from "@/components/deliverability/remove-from-campaigns-dialog";
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
  return (
    <Suspense>
      <DeliverabilityPageInner />
    </Suspense>
  );
}

function DeliverabilityPageInner() {
  const searchParams = useSearchParams();
  const [domains, setDomains] = useState<DomainRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [syncStats, setSyncStats] = useState<{ inboxCount: number; domainCount: number } | null>(null);
  const [tagFilters, setTagFilters] = useState<string[]>(() => {
    const t = searchParams.get("tags");
    return t ? t.split(",").map((s) => s.trim()).filter(Boolean) : [];
  });
  const [warmupFilter, setWarmupFilter] = useState<"all" | "open" | "done">("open");
  const [warmupTypeFilter, setWarmupTypeFilter] = useState<"all" | "outlook" | "google">("all");
  const [activeTab, setActiveTab] = useState<"inboxes" | "warmup">("inboxes");
  const [allTags, setAllTags] = useState<string[]>([]);
  const [savedPage, setSavedPage] = useState<number | null>(null);
  const [domainSearch, setDomainSearch] = useState("");
  const [warmupSearch, setWarmupSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "outlook" | "google">("all");
  const [showFlagged, setShowFlagged] = useState(() => searchParams.get("flagged") === "true");
  const [flagSubFilter, setFlagSubFilter] = useState<"all" | "reply" | "bounce">("all");
  const [showReserve, setShowReserve] = useState(false);
  const [warmupDaysFilter, setWarmupDaysFilter] = useState<string>("all");
  const [attachDialogOpen, setAttachDialogOpen] = useState(false);
  const [clientTags, setClientTags] = useState<Set<string>>(new Set());
  const [selectedDomains, setSelectedDomains] = useState<Set<string>>(new Set());
  const [bulkTagMode, setBulkTagMode] = useState<"add" | "remove" | null>(null);
  const [showBulkDelete, setShowBulkDelete] = useState(false);
  const [showAttachCampaigns, setShowAttachCampaigns] = useState(false);
  const [showRemoveFromCampaigns, setShowRemoveFromCampaigns] = useState(false);

  // Background attach state
  interface AttachJob { campaign: string; status: "pending" | "running" | "done" | "error"; newly: number; existing: number; error?: string }
  const [attachJobs, setAttachJobs] = useState<AttachJob[]>([]);
  const [attachRunning, setAttachRunning] = useState(false);
  const attachDomainsRef = useRef<string[]>([]);

  // Background tag + campaign combo state
  interface TagCampaignJob {
    tagStatus: "running" | "done" | "error";
    tagLabel: string;
    tagAffected?: number;
    tagError?: string;
    campaignJobs: AttachJob[];
    campaignsDone: boolean;
    domains: string[];
  }
  const [tagCampaignJob, setTagCampaignJob] = useState<TagCampaignJob | null>(null);
  const [domainsCopied, setDomainsCopied] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exportCopied, setExportCopied] = useState(false);

  // Drag-to-select state
  const isDragging = useRef(false);
  const dragSelectMode = useRef<boolean>(true); // true = selecting, false = deselecting


  const startBackgroundAttach = useCallback(async (campaigns: { id: number; name: string }[], domains: string[]) => {
    attachDomainsRef.current = domains;
    const jobs: AttachJob[] = campaigns.map((c) => ({ campaign: c.name, status: "pending" as const, newly: 0, existing: 0 }));
    setAttachJobs(jobs);
    setAttachRunning(true);
    setSelectedDomains(new Set());

    for (let i = 0; i < campaigns.length; i++) {
      const campaign = campaigns[i];
      setAttachJobs((prev) => prev.map((j, idx) => idx === i ? { ...j, status: "running" } : j));

      let success = false;
      let lastError = "";
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch("/api/deliverability/attach-domains-to-campaign", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ campaign_id: campaign.id, domains: attachDomainsRef.current }),
          });
          const data = await res.json();
          if (res.ok) {
            setAttachJobs((prev) => prev.map((j, idx) => idx === i ? { ...j, status: "done", newly: data.newly_attached || 0, existing: data.already_attached || 0 } : j));
            success = true;
            break;
          }
          lastError = data.error || `HTTP ${res.status}`;
        } catch (e) {
          lastError = e instanceof Error ? e.message : "Network error";
        }
        if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
      }
      if (!success) {
        setAttachJobs((prev) => prev.map((j, idx) => idx === i ? { ...j, status: "error", error: lastError } : j));
      }
    }
    setAttachRunning(false);
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem("deliverability_next_page");
    if (saved) setSavedPage(parseInt(saved, 10));
  }, []);

  // Fetch client tags from Client Tracker + Sheet6
  useEffect(() => {
    fetch("/api/client-tags")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setClientTags(new Set(data));
      })
      .catch(() => {});
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

  const startBackgroundTagCampaign = useCallback(async (info: TagApplyInfo) => {
    const tagLabel = `${info.mode === "add" ? "Adding" : "Removing"} ${info.tagNames.join(", ")}`;
    const campaignJobs: AttachJob[] = info.campaigns.map((c) => ({ campaign: c.name, status: "pending" as const, newly: 0, existing: 0 }));
    setTagCampaignJob({ tagStatus: "running", tagLabel, campaignJobs, campaignsDone: info.campaigns.length === 0, domains: info.domains });
    setSelectedDomains(new Set());
    setDomainsCopied(false);

    // Run tags + campaigns in parallel
    const tagPromise = fetch("/api/deliverability/bulk-tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: info.mode, tagIds: info.tagIds, domains: info.domains }),
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
        setTagCampaignJob((prev) => prev ? {
          ...prev,
          campaignJobs: prev.campaignJobs.map((j, idx) => idx === i ? { ...j, status: "running" } : j),
        } : prev);

        try {
          const res = await fetch("/api/deliverability/attach-domains-to-campaign", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ campaign_id: campaign.id, domains: info.domains }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          setTagCampaignJob((prev) => prev ? {
            ...prev,
            campaignJobs: prev.campaignJobs.map((j, idx) => idx === i ? { ...j, status: "done", newly: data.newly_attached || 0, existing: data.already_attached || 0 } : j),
          } : prev);
        } catch (err) {
          setTagCampaignJob((prev) => prev ? {
            ...prev,
            campaignJobs: prev.campaignJobs.map((j, idx) => idx === i ? { ...j, status: "error", error: err instanceof Error ? err.message : "Failed" } : j),
          } : prev);
        }
      }
      setTagCampaignJob((prev) => prev ? { ...prev, campaignsDone: true } : prev);
    })();

    await Promise.all([tagPromise, campaignPromise]);
    loadDomains();
    loadTags();
  }, [loadDomains, loadTags]);

  useEffect(() => {
    loadDomains();
    loadStats();
    loadTags();
  }, [loadDomains, loadStats, loadTags]);

  // Use ref for progress so parallel stream closures always see latest values
  const progressRef = useRef({ synced: 0, pagesProcessed: 0, lastPage: 0 });

  const handleSync = async () => {
    setSyncing(true);
    const CHUNK = 20;
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

    // Single stream worker with retry
    const runStream = async (streamId: number, start: number, end: number) => {
      let page = start;
      console.log(`[STREAM ${streamId}] Starting pages ${start}-${end}`);
      while (page <= end) {
        let success = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          const t0 = performance.now();
          try {
            const res = await fetch("/api/deliverability/sync", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ startPage: page, pagesPerChunk: CHUNK }),
            });
            if (!res.ok) {
              console.warn(`[STREAM ${streamId}] Page ${page} attempt ${attempt}: ${res.status}`);
              if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
              continue;
            }
            const result = await res.json();
            const ms = Math.round(performance.now() - t0);
            const pagesInChunk = Math.min(CHUNK, end - page + 1);
            progressRef.current.synced += result.synced || 0;
            progressRef.current.pagesProcessed += pagesInChunk;
            flushProgress();
            console.log(`[STREAM ${streamId}] Pages ${page}-${page + pagesInChunk - 1}: ${result.synced} inboxes, ${result.domains} domains in ${ms}ms`);
            success = true;
            break;
          } catch (e) {
            console.warn(`[STREAM ${streamId}] Page ${page} attempt ${attempt} error:`, e);
            if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
          }
        }
        if (!success) {
          console.error(`[STREAM ${streamId}] FAILED at page ${page} after 3 attempts, skipping chunk`);
        }
        page += CHUNK;
      }
      console.log(`[STREAM ${streamId}] Done`);
    };

    try {
      // First fetch to discover lastPage
      const syncStart = performance.now();
      const resumeFrom = savedPage ?? 1;
      console.log(`[SYNC] Starting from page ${resumeFrom}, chunk=${CHUNK}, streams=${STREAMS}`);
      const firstRes = await fetch("/api/deliverability/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startPage: resumeFrom, pagesPerChunk: CHUNK }),
      });
      if (!firstRes.ok) { console.error("[SYNC] First chunk failed"); setSyncing(false); return; }
      const firstResult = await firstRes.json();
      const lastPage = firstResult.lastPage || 1;
      console.log(`[SYNC] First chunk done: ${firstResult.synced} inboxes, lastPage=${lastPage}, total pages=${lastPage - resumeFrom + 1}`);
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

        console.log(`[SYNC] Launching ${ranges.length} streams:`, ranges.map((r) => `${r.start}-${r.end}`).join(", "));
        await Promise.all(ranges.map((r, i) => runStream(i + 1, r.start, r.end)));
      }

      localStorage.removeItem("deliverability_next_page");
      setSavedPage(null);

      // Rebuild domain stats from all inboxes
      console.log("[SYNC] Rebuilding domain stats...");
      const rebuildRes = await fetch("/api/deliverability/sync", { method: "PUT" });
      const rebuildData = await rebuildRes.json();
      console.log(`[SYNC] Domain rebuild: ${rebuildData.domains} domains from ${rebuildData.inboxes} inboxes`);

      const totalSec = ((performance.now() - syncStart) / 1000).toFixed(1);
      console.log(`[SYNC] COMPLETE in ${totalSec}s — ${progressRef.current.synced} total inboxes`);

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

  // Reserve = domain has no client tags (may have other tags like "Cheap Inboxes", "JPTUC", etc.)
  const isDomainReserve = useCallback((d: DomainRow) => {
    if (clientTags.size === 0) return false; // not loaded yet
    if (!d.tags || d.tags.length === 0) return true;
    return !d.tags.some((t) => clientTags.has(t));
  }, [clientTags]);

  const reserveCount = useMemo(() => domains.filter(isDomainReserve).length, [domains, isDomainReserve]);

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
        )
        .filter((d) => showReserve ? isDomainReserve(d) : true)
        .filter((d) => {
          if (warmupTypeFilter === "outlook") return (d.outlook_count || 0) > 0;
          if (warmupTypeFilter === "google") return (d.google_count || 0) > 0;
          return true;
        })
        .filter((d) => {
          if (tagFilters.length === 0) return true;
          return d.tags && tagFilters.every((tag) => d.tags!.includes(tag));
        }),
    [domains, warmupFilter, warmupSearch, showReserve, warmupTypeFilter, tagFilters, isDomainReserve, now]
  );

  // Flag computation helper — returns human-readable reason strings
  // Uses rate-based thresholds: reply rate < 1%, bounce rate > 3%, min 100 sent
  const getFlagReasons = useCallback((d: DomainRow): string[] => {
    const reasons: string[] = [];
    const isGoogle = (d.google_count || 0) > 0 && (d.outlook_count || 0) === 0;
    const isOutlook = (d.outlook_count || 0) > 0 && (d.google_count || 0) === 0;
    const totalSent = d.total_sent || 0;
    if (!(isGoogle || isOutlook) || totalSent <= 100) return reasons;

    const replied = d.total_replied || 0;
    const bounced = d.total_bounced || 0;
    const replyRate = totalSent > 0 ? replied / totalSent : 0;
    const bounceRate = totalSent > 0 ? bounced / totalSent : 0;

    if (replyRate < 0.01) {
      reasons.push(`Low replies (${(replyRate * 100).toFixed(1)}% with ${totalSent.toLocaleString()} sent)`);
    }
    if (bounceRate > 0.03) {
      reasons.push(`High bounces (${(bounceRate * 100).toFixed(1)}% with ${totalSent.toLocaleString()} sent)`);
    }
    return reasons;
  }, []);

  const isDomainFlagged = useCallback((d: DomainRow) => getFlagReasons(d).length > 0, [getFlagReasons]);

  const hasReplyIssue = useCallback((d: DomainRow) => {
    return getFlagReasons(d).some((r) => r.startsWith("Low replies"));
  }, [getFlagReasons]);

  const hasBounceIssue = useCallback((d: DomainRow) => {
    return getFlagReasons(d).some((r) => r.startsWith("High bounces"));
  }, [getFlagReasons]);

  // Client-side filter: tag match (OR) + domain search + type filter + flagged
  // Export helpers
  const exportDomainsCsv = useCallback(() => {
    const selected = domains.filter((d) => selectedDomains.has(d.domain));
    const header = "Domain,Inboxes,Outlook,Google,Sent,Replied,Bounced,Tags";
    const rows = selected.map((d) =>
      `${d.domain},${d.inbox_count},${d.outlook_count || 0},${d.google_count || 0},${d.total_sent || 0},${d.total_replied || 0},${d.total_bounced || 0},"${(d.tags || []).join(", ")}"`
    );
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `domains-export-${selectedDomains.size}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setShowExportMenu(false);
  }, [domains, selectedDomains]);

  const copyDomainsToClipboard = useCallback(() => {
    const domainList = Array.from(selectedDomains).join("\n");
    navigator.clipboard.writeText(domainList);
    setExportCopied(true);
    setTimeout(() => { setExportCopied(false); setShowExportMenu(false); }, 1500);
  }, [selectedDomains]);

  // Drag-to-select handlers
  const handleDragStart = useCallback((domain: string) => {
    isDragging.current = true;
    const wasSelected = selectedDomains.has(domain);
    dragSelectMode.current = !wasSelected;
    setSelectedDomains((prev) => {
      const next = new Set(prev);
      if (dragSelectMode.current) next.add(domain);
      else next.delete(domain);
      return next;
    });
  }, [selectedDomains]);

  const handleDragEnter = useCallback((domain: string) => {
    if (!isDragging.current) return;
    setSelectedDomains((prev) => {
      const next = new Set(prev);
      if (dragSelectMode.current) next.add(domain);
      else next.delete(domain);
      return next;
    });
  }, []);

  useEffect(() => {
    const handleMouseUp = () => { isDragging.current = false; };
    const handleClickOutside = () => setShowExportMenu(false);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("click", handleClickOutside);
    return () => { window.removeEventListener("mouseup", handleMouseUp); window.removeEventListener("click", handleClickOutside); };
  }, []);

  const filteredDomains = useMemo(() => {
    let result = domains;
    if (tagFilters.length > 0) {
      result = result.filter((d) =>
        d.tags && tagFilters.every((tag) => d.tags!.includes(tag))
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
      if (flagSubFilter === "reply") {
        result = result.filter(hasReplyIssue);
      } else if (flagSubFilter === "bounce") {
        result = result.filter(hasBounceIssue);
      } else {
        result = result.filter(isDomainFlagged);
      }
    }
    if (showReserve) {
      result = result.filter(isDomainReserve);
    }
    if (warmupDaysFilter !== "all") {
      result = result.filter((d) => {
        const daysOld = d.domain_created_at
          ? Math.floor((now - new Date(d.domain_created_at).getTime()) / (1000 * 60 * 60 * 24))
          : 0;
        const daysLeft = Math.max(0, 21 - daysOld);
        if (warmupDaysFilter === "complete") return daysLeft === 0;
        const maxDays = parseInt(warmupDaysFilter);
        if (!isNaN(maxDays)) return daysLeft > 0 && daysLeft <= maxDays;
        return true;
      });
    }
    return result;
  }, [domains, tagFilters, domainSearch, typeFilter, showFlagged, flagSubFilter, showReserve, warmupDaysFilter, isDomainFlagged, hasReplyIssue, hasBounceIssue, isDomainReserve, now]);

  const flaggedCount = useMemo(() => domains.filter(isDomainFlagged).length, [domains, isDomainFlagged]);

  // Warmup-specific reserve count (only warmup-complete domains)
  const warmupReserveCount = useMemo(() => {
    return domains
      .filter((d) => {
        const daysOld = d.domain_created_at
          ? Math.floor((now - new Date(d.domain_created_at).getTime()) / (1000 * 60 * 60 * 24))
          : 0;
        return daysOld >= 21;
      })
      .filter(isDomainReserve).length;
  }, [domains, isDomainReserve, now]);
  const replyIssueCount = useMemo(() => domains.filter(hasReplyIssue).length, [domains, hasReplyIssue]);
  const bounceIssueCount = useMemo(() => domains.filter(hasBounceIssue).length, [domains, hasBounceIssue]);

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

      {/* Background Attach Progress */}
      {attachJobs.length > 0 && (
        <div className="rounded-lg border bg-muted/30 px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-sm">
              {attachRunning && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
              <span className="font-medium">
                {attachRunning ? "Attaching to campaigns..." : "Attachment complete"}
              </span>
              <span className="text-xs text-muted-foreground">
                {attachJobs.filter((j) => j.status === "done").length}/{attachJobs.length} campaigns
              </span>
            </div>
            {!attachRunning && (
              <button onClick={() => setAttachJobs([])} className="text-xs text-muted-foreground hover:text-foreground">
                Dismiss
              </button>
            )}
          </div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {attachJobs.map((job, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                {job.status === "running" && <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />}
                {job.status === "done" && <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />}
                {job.status === "error" && <AlertTriangle className="h-3 w-3 text-destructive shrink-0" />}
                {job.status === "pending" && <div className="h-3 w-3 rounded-full border border-muted-foreground/30 shrink-0" />}
                <span className="truncate text-muted-foreground">{job.campaign}</span>
                {job.status === "done" && (
                  <span className="shrink-0 ml-auto text-emerald-500">+{job.newly} · {job.existing} existing</span>
                )}
                {job.status === "error" && (
                  <span className="shrink-0 ml-auto text-destructive">{job.error}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Background Tag + Campaign Progress */}
      {tagCampaignJob && (
        <div className="rounded-lg border bg-muted/30 px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-sm">
              {(tagCampaignJob.tagStatus === "running" || !tagCampaignJob.campaignsDone) && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
              {tagCampaignJob.tagStatus !== "running" && tagCampaignJob.campaignsDone && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
              <span className="font-medium">
                {tagCampaignJob.tagStatus === "running" || !tagCampaignJob.campaignsDone ? "Processing..." : "Complete"}
              </span>
            </div>
            {tagCampaignJob.tagStatus !== "running" && tagCampaignJob.campaignsDone && (
              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(tagCampaignJob.domains.join("\n"));
                    setDomainsCopied(true);
                    setTimeout(() => setDomainsCopied(false), 2000);
                  }}
                  className="text-xs text-primary hover:underline"
                >
                  {domainsCopied ? "Copied!" : "Copy Domains"}
                </button>
                <button onClick={() => setTagCampaignJob(null)} className="text-xs text-muted-foreground hover:text-foreground">Dismiss</button>
              </div>
            )}
          </div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {/* Tag status line */}
            <div className="flex items-center gap-2 text-xs">
              {tagCampaignJob.tagStatus === "running" && <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />}
              {tagCampaignJob.tagStatus === "done" && <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />}
              {tagCampaignJob.tagStatus === "error" && <AlertTriangle className="h-3 w-3 text-destructive shrink-0" />}
              <span className="text-muted-foreground">{tagCampaignJob.tagLabel}</span>
              {tagCampaignJob.tagStatus === "done" && <span className="shrink-0 ml-auto text-emerald-500">{tagCampaignJob.tagAffected} inboxes</span>}
              {tagCampaignJob.tagStatus === "error" && <span className="shrink-0 ml-auto text-destructive">{tagCampaignJob.tagError}</span>}
            </div>
            {/* Campaign lines */}
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
              onClick={() => { setShowFlagged((v) => !v); setFlagSubFilter("all"); }}
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

            {/* Flag sub-filters — only visible when flagged is active */}
            {showFlagged && (
              <>
                <button
                  onClick={() => setFlagSubFilter(flagSubFilter === "reply" ? "all" : "reply")}
                  className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                    flagSubFilter === "reply"
                      ? "bg-amber-500/15 text-amber-500 border-amber-500/30"
                      : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                  }`}
                >
                  Low Replies
                  <span className="ml-1 opacity-60">{replyIssueCount}</span>
                </button>
                <button
                  onClick={() => setFlagSubFilter(flagSubFilter === "bounce" ? "all" : "bounce")}
                  className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                    flagSubFilter === "bounce"
                      ? "bg-red-500/15 text-red-400 border-red-500/30"
                      : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                  }`}
                >
                  High Bounces
                  <span className="ml-1 opacity-60">{bounceIssueCount}</span>
                </button>
              </>
            )}

            {/* Reserve filter */}
            <button
              onClick={() => setShowReserve((v) => !v)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors flex items-center gap-1.5 ${
                showReserve
                  ? "bg-amber-500 text-white border-amber-500"
                  : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
              }`}
            >
              <Inbox className="h-3 w-3" />
              Reserve
              {reserveCount > 0 && (
                <span className={`text-[10px] font-medium rounded-full px-1.5 ${
                  showReserve ? "bg-white/20" : "bg-amber-500/15 text-amber-600"
                }`}>
                  {reserveCount}
                </span>
              )}
            </button>

            {/* Warmup days filter */}
            <div className="flex items-center gap-1">
              {[
                { value: "all", label: "All Warmup" },
                { value: "complete", label: "Complete" },
              ].map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setWarmupDaysFilter(opt.value)}
                  className={`text-xs px-2.5 py-1.5 rounded-full border transition-colors ${
                    warmupDaysFilter === opt.value
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
              <div className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border transition-colors ${
                warmupDaysFilter !== "all" && warmupDaysFilter !== "complete"
                  ? "border-primary text-primary"
                  : "border-border text-muted-foreground"
              }`}>
                <span>≤</span>
                <input
                  type="number"
                  min="1"
                  max="21"
                  placeholder="days"
                  value={warmupDaysFilter !== "all" && warmupDaysFilter !== "complete" ? warmupDaysFilter : ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (!v) { setWarmupDaysFilter("all"); return; }
                    const n = parseInt(v);
                    if (n >= 1 && n <= 21) setWarmupDaysFilter(String(n));
                  }}
                  onFocus={() => {
                    if (warmupDaysFilter === "all" || warmupDaysFilter === "complete") setWarmupDaysFilter("");
                  }}
                  className="w-8 bg-transparent outline-none text-center tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <span>days</span>
              </div>
            </div>

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

            {(tagFilters.length > 0 || domainSearch || typeFilter !== "all" || showReserve || warmupDaysFilter !== "all") && (
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
              {/* Bulk action bar */}
              {selectedDomains.size > 0 && (
                <div className="flex items-center gap-3 rounded-xl border bg-muted/50 px-4 py-2.5">
                  <span className="text-xs font-medium">
                    {selectedDomains.size} domain{selectedDomains.size !== 1 ? "s" : ""} selected
                  </span>
                  <div className="flex items-center gap-2 ml-auto">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs gap-1.5"
                      onClick={() => setBulkTagMode("add")}
                    >
                      + Add Tags
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs gap-1.5"
                      onClick={() => setShowAttachCampaigns(true)}
                    >
                      Attach to Campaigns
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs gap-1.5 text-amber-500 hover:text-amber-500"
                      onClick={() => setShowRemoveFromCampaigns(true)}
                    >
                      Remove from Campaigns
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs gap-1.5 text-destructive hover:text-destructive"
                      onClick={() => setBulkTagMode("remove")}
                    >
                      − Remove Tags
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      className="h-7 text-xs gap-1.5"
                      onClick={() => setShowBulkDelete(true)}
                    >
                      Delete
                    </Button>
                    <div className="relative">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1.5"
                        onClick={() => setShowExportMenu((v) => !v)}
                      >
                        <Download className="h-3 w-3" />
                        Export
                      </Button>
                      {showExportMenu && (
                        <div className="absolute top-full right-0 mt-1 z-50 rounded-lg border bg-popover shadow-md py-1 min-w-[160px]">
                          <button
                            onClick={copyDomainsToClipboard}
                            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-muted transition-colors"
                          >
                            <Copy className="h-3 w-3" />
                            {exportCopied ? "Copied!" : "Copy Domains"}
                          </button>
                          <button
                            onClick={exportDomainsCsv}
                            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-muted transition-colors"
                          >
                            <Download className="h-3 w-3" />
                            Download CSV
                          </button>
                        </div>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => setSelectedDomains(new Set())}
                    >
                      Clear
                    </Button>
                  </div>
                </div>
              )}

              {/* Table header */}
              <div className="grid grid-cols-[28px_1fr_100px_80px_80px_80px_100px] gap-3 px-4 py-2 text-xs text-muted-foreground font-medium">
                <button
                  onClick={() => {
                    const allVisible = filteredDomains.map((d) => d.domain);
                    const allSelected = allVisible.every((d) => selectedDomains.has(d));
                    if (allSelected) {
                      setSelectedDomains(new Set());
                    } else {
                      setSelectedDomains(new Set(allVisible));
                    }
                  }}
                  className={`h-4 w-4 rounded border flex items-center justify-center transition-colors ${
                    filteredDomains.length > 0 && filteredDomains.every((d) => selectedDomains.has(d.domain))
                      ? "bg-primary border-primary text-primary-foreground"
                      : "border-muted-foreground/30 hover:border-foreground"
                  }`}
                >
                  {filteredDomains.length > 0 && filteredDomains.every((d) => selectedDomains.has(d.domain)) && (
                    <Check className="h-3 w-3" />
                  )}
                </button>
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

                const isSelected = selectedDomains.has(d.domain);

                return (
                  <div
                    key={d.domain}
                    onMouseEnter={() => handleDragEnter(d.domain)}
                    className={`grid grid-cols-[28px_1fr_100px_80px_80px_80px_100px] gap-3 items-center rounded-xl border px-4 py-3 transition-colors select-none ${
                      isSelected
                        ? "bg-primary/5 border-primary/30"
                        : flagged
                          ? "bg-destructive/5 border-destructive/30 hover:bg-destructive/10"
                          : "bg-card hover:bg-muted/30"
                    }`}
                  >
                    {/* Checkbox — supports drag-to-select */}
                    <button
                      onMouseDown={(e) => { e.preventDefault(); handleDragStart(d.domain); }}
                      className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                        isSelected
                          ? "bg-primary border-primary text-primary-foreground"
                          : "border-muted-foreground/30 hover:border-foreground"
                      }`}
                    >
                      {isSelected && <Check className="h-3 w-3" />}
                    </button>

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
                        (d.total_sent || 0) > 100 && (d.total_replied || 0) / (d.total_sent || 1) < 0.01
                          ? "text-destructive" : ""
                      }`}>{(d.total_replied || 0).toLocaleString()}</div>
                      <div className="text-[10px] text-muted-foreground">{replyRate}%</div>
                    </div>

                    {/* Bounced */}
                    <div className={`text-center text-sm font-medium ${
                      (d.total_sent || 0) > 100 && (d.total_bounced || 0) / (d.total_sent || 1) > 0.03
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

            {/* Tag filter */}
            <TagFilterDropdown
              allTags={allTags}
              selected={tagFilters}
              onChange={setTagFilters}
            />

            {/* Type filter */}
            {(["all", "outlook", "google"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setWarmupTypeFilter(t)}
                className={`text-xs px-3 py-1.5 rounded-full border capitalize transition-colors ${
                  warmupTypeFilter === t
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                }`}
              >
                {t === "all" ? "All Types" : t === "outlook" ? "Outlook" : "Google"}
              </button>
            ))}

            {/* Reserve filter (warmup-specific count) */}
            <button
              onClick={() => setShowReserve((v) => !v)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors flex items-center gap-1.5 ${
                showReserve
                  ? "bg-amber-500 text-white border-amber-500"
                  : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
              }`}
            >
              <Inbox className="h-3 w-3" />
              Reserve
              {warmupReserveCount > 0 && (
                <span className={`text-[10px] font-medium rounded-full px-1.5 ${
                  showReserve ? "bg-white/20" : "bg-amber-500/15 text-amber-600"
                }`}>
                  {warmupReserveCount}
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

            {warmupDomains.length !== domains.length && (
              <span className="text-xs text-muted-foreground">
                {warmupDomains.length} domain{warmupDomains.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>

          {/* Bulk action bar for warmup */}
          {selectedDomains.size > 0 && (
            <div className="flex items-center gap-3 rounded-xl border bg-muted/50 px-4 py-2.5">
              <span className="text-xs font-medium">
                {selectedDomains.size} domain{selectedDomains.size !== 1 ? "s" : ""} selected
              </span>
              <div className="flex items-center gap-2 ml-auto">
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={() => setBulkTagMode("add")}>
                  + Add Tags
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={() => setShowAttachCampaigns(true)}>
                  Attach to Campaigns
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5 text-destructive hover:text-destructive" onClick={() => setBulkTagMode("remove")}>
                  − Remove Tags
                </Button>
                <Button size="sm" variant="destructive" className="h-7 text-xs gap-1.5" onClick={() => setShowBulkDelete(true)}>
                  Delete
                </Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setSelectedDomains(new Set())}>
                  Clear
                </Button>
              </div>
            </div>
          )}

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
            <div className="space-y-1.5">
              {/* Select all header */}
              <div className="flex items-center gap-3 px-4 py-1.5">
                <button
                  onClick={() => {
                    const allVisible = warmupDomains.map((d) => d.domain);
                    const allSelected = allVisible.every((d) => selectedDomains.has(d));
                    if (allSelected) setSelectedDomains(new Set());
                    else setSelectedDomains(new Set(allVisible));
                  }}
                  className={`h-4 w-4 rounded border flex items-center justify-center transition-colors ${
                    warmupDomains.length > 0 && warmupDomains.every((d) => selectedDomains.has(d.domain))
                      ? "bg-primary border-primary text-primary-foreground"
                      : "border-muted-foreground/30 hover:border-foreground"
                  }`}
                >
                  {warmupDomains.length > 0 && warmupDomains.every((d) => selectedDomains.has(d.domain)) && (
                    <Check className="h-3 w-3" />
                  )}
                </button>
                <span className="text-xs text-muted-foreground">{warmupDomains.length} domains</span>
              </div>

              {warmupDomains.map((d) => {
                const isSelected = selectedDomains.has(d.domain);
                return (
                  <div
                    key={d.domain}
                    className={`flex items-center gap-3 rounded-xl border px-4 py-3 transition-colors ${
                      isSelected ? "bg-primary/5 border-primary/30" : "bg-card hover:bg-muted/30"
                    }`}
                  >
                    {/* Checkbox */}
                    <button
                      onClick={() => {
                        setSelectedDomains((prev) => {
                          const next = new Set(prev);
                          if (next.has(d.domain)) next.delete(d.domain);
                          else next.add(d.domain);
                          return next;
                        });
                      }}
                      className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                        isSelected
                          ? "bg-primary border-primary text-primary-foreground"
                          : "border-muted-foreground/30 hover:border-foreground"
                      }`}
                    >
                      {isSelected && <Check className="h-3 w-3" />}
                    </button>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="font-medium text-sm">{d.domain}</span>
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5 ml-5">
                        Added{" "}
                        {new Date(d.domain_created_at!).toLocaleDateString("en-US", {
                          month: "short", day: "numeric", year: "numeric",
                        })}
                        {" · "}{d.daysOld} days old
                        {" · "}{d.inbox_count} inbox{d.inbox_count !== 1 ? "es" : ""}
                        {(d.outlook_count || 0) > 0 && <span className="text-blue-400 ml-1">{d.outlook_count} OL</span>}
                        {(d.google_count || 0) > 0 && <span className="text-red-400 ml-1">{d.google_count} G</span>}
                      </div>
                      {d.tags && d.tags.length > 0 && (
                        <div className="flex gap-1 flex-wrap mt-1 ml-5">
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
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Attach Campaigns Dialog */}
      <AttachCampaignsDialog open={attachDialogOpen} onOpenChange={setAttachDialogOpen} />

      {/* Bulk Tag Dialog */}
      {bulkTagMode && (
        <BulkTagDialog
          mode={bulkTagMode}
          open={!!bulkTagMode}
          onOpenChange={(open) => { if (!open) setBulkTagMode(null); }}
          selectedDomains={Array.from(selectedDomains)}
          existingTags={(() => {
            const tagSet = new Set<string>();
            for (const domain of selectedDomains) {
              const d = domains.find((dd) => dd.domain === domain);
              if (d?.tags) d.tags.forEach((t) => tagSet.add(t));
            }
            return Array.from(tagSet);
          })()}
          availableTags={
            bulkTagMode === "remove"
              ? (() => {
                  const tagMap = new Map<string, { id: number; name: string }>();
                  for (const domain of selectedDomains) {
                    const d = domains.find((dd) => dd.domain === domain);
                    if (d?.tags) {
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
        onSuccess={() => {
          loadDomains();
          loadStats();
          loadTags();
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
    </div>
  );
}
