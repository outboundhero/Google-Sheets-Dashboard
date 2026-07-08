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
  ChevronUp,
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
  ExternalLink,
  Tags,
  SlidersHorizontal,
  Plus,
  ShieldAlert,
  ArrowRightLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/shared/page-header";
import { AttachCampaignsDialog } from "@/components/deliverability/attach-campaigns-dialog";
import { BulkTagDialog, type TagApplyInfo } from "@/components/deliverability/bulk-tag-dialog";
import { BulkDeleteDialog } from "@/components/deliverability/bulk-delete-dialog";
import { AttachToCampaignsDialog } from "@/components/deliverability/attach-to-campaigns-dialog";
import { RemoveFromCampaignsDialog } from "@/components/deliverability/remove-from-campaigns-dialog";
import { ConformTagsDialog } from "@/components/deliverability/conform-tags-dialog";
import { ChangeRedirectDialog } from "@/components/deliverability/change-redirect-dialog";
import { MoveDomainsDialog, type MoveJob } from "@/components/deliverability/move-domains-dialog";
import { SendToSheetDialog } from "@/components/deliverability/send-to-sheet-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/lib/auth-context";
import { useInstance } from "@/lib/instance-context";
import { useProviderStatus } from "@/lib/hooks/use-provider-status";
import { useDomainInstances } from "@/lib/hooks/use-domain-instances";
import { getDomainFlagReasons } from "@/lib/inbox-health";
import { ALL_INSTANCE_SLUGS, BISON_INSTANCES, INSTANCE_SHORT_LABELS, type BisonInstanceSlug } from "@/lib/bison-instances";

interface DomainRow {
  instance: BisonInstanceSlug;
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
  daily_limit_total?: number;
  warmup_limit_total?: number;
  redirect_url?: string | null;
  redirect_checked_at?: string | null;
  blacklisted?: boolean | null;
  blacklist_checked_at?: string | null;
  spamhaus_dbl?: boolean | null;
  spamhaus_checked_at?: string | null;
  // Trailing reply/bounce rates (%), null until enough snapshot history exists
  reply_10?: number | null;
  reply_15?: number | null;
  reply_30?: number | null;
  bounce_10?: number | null;
  bounce_15?: number | null;
  bounce_30?: number | null;
}

// --- Multi-condition filter (up to 8, combined with AND or OR). Fields are
// typed by KIND: number (comparison ops), boolean (is Yes/No), enum
// (is / is not a picked value), text (contains / doesn't contain). -------
type FilterField =
  | "inbox_count" | "total_sent" | "total_replied" | "reply_rate"
  | "total_bounced" | "bounce_rate" | "daily_limit_total"
  | "reply_10" | "reply_15" | "reply_30" | "bounce_10" | "bounce_15" | "bounce_30"
  | "domain_age_days" | "warmup_days_left" | "outlook_count" | "google_count" | "warmup_limit_total"
  | "blacklisted" | "spamhaus_dbl" | "warmup_complete" | "provider_status"
  | "instance_presence"
  | "tags_text" | "redirect_url_text";
type FilterOp = ">=" | ">" | "=" | "<" | "<=" | "is" | "is_not" | "contains" | "not_contains";
type FilterFieldKind = "number" | "boolean" | "enum" | "text";
interface FilterCondition { id: number; field: FilterField; op: FilterOp; value: string; }

interface FilterFieldDef {
  value: FilterField;
  label: string;
  kind: FilterFieldKind;
  group: string;
  options?: { value: string; label: string }[]; // enum choices
}

const FILTER_FIELDS: FilterFieldDef[] = [
  // Volume
  { value: "total_sent", label: "Emails sent", kind: "number", group: "Volume" },
  { value: "total_replied", label: "Replies", kind: "number", group: "Volume" },
  { value: "total_bounced", label: "Bounces", kind: "number", group: "Volume" },
  { value: "inbox_count", label: "Inboxes", kind: "number", group: "Volume" },
  { value: "outlook_count", label: "Outlook inboxes", kind: "number", group: "Volume" },
  { value: "google_count", label: "Google inboxes", kind: "number", group: "Volume" },
  { value: "daily_limit_total", label: "Daily limit", kind: "number", group: "Volume" },
  { value: "warmup_limit_total", label: "Warmup limit", kind: "number", group: "Volume" },
  // Rates
  { value: "reply_rate", label: "Reply rate % (all)", kind: "number", group: "Rates" },
  { value: "bounce_rate", label: "Bounce rate % (all)", kind: "number", group: "Rates" },
  { value: "reply_10", label: "Reply rate % (10d)", kind: "number", group: "Rates" },
  { value: "reply_15", label: "Reply rate % (15d)", kind: "number", group: "Rates" },
  { value: "reply_30", label: "Reply rate % (30d)", kind: "number", group: "Rates" },
  { value: "bounce_10", label: "Bounce rate % (10d)", kind: "number", group: "Rates" },
  { value: "bounce_15", label: "Bounce rate % (15d)", kind: "number", group: "Rates" },
  { value: "bounce_30", label: "Bounce rate % (30d)", kind: "number", group: "Rates" },
  // Domain / warmup
  { value: "domain_age_days", label: "Domain age (days)", kind: "number", group: "Domain" },
  { value: "warmup_days_left", label: "Warmup days left", kind: "number", group: "Domain" },
  { value: "warmup_complete", label: "Warmup complete", kind: "boolean", group: "Domain" },
  // Status
  { value: "blacklisted", label: "SURBL listed", kind: "boolean", group: "Status" },
  { value: "spamhaus_dbl", label: "Spamhaus listed", kind: "boolean", group: "Status" },
  {
    value: "provider_status", label: "Provider status", kind: "enum", group: "Status",
    options: [
      { value: "active", label: "Active" },
      { value: "canceled", label: "Canceled" },
      { value: "unknown", label: "Unknown" },
    ],
  },
  // Instance
  {
    value: "instance_presence", label: "Exists in instance", kind: "enum", group: "Instance",
    options: ALL_INSTANCE_SLUGS.map((s) => ({ value: s, label: INSTANCE_SHORT_LABELS[s] })),
  },
  // Text
  { value: "tags_text", label: "Tag contains", kind: "text", group: "Text" },
  { value: "redirect_url_text", label: "Redirect URL contains", kind: "text", group: "Text" },
];

const NUMBER_OPS: FilterOp[] = [">=", ">", "=", "<", "<="];
const OPS_BY_KIND: Record<FilterFieldKind, { value: FilterOp; label: string }[]> = {
  number: NUMBER_OPS.map((o) => ({ value: o, label: o })),
  boolean: [{ value: "is", label: "is" }],
  enum: [{ value: "is", label: "is" }, { value: "is_not", label: "is not" }],
  text: [{ value: "contains", label: "contains" }, { value: "not_contains", label: "doesn't contain" }],
};
const filterFieldDef = (f: FilterField): FilterFieldDef =>
  FILTER_FIELDS.find((d) => d.value === f) ?? FILTER_FIELDS[0];
// Defaults applied when the user switches a condition to a new field.
const defaultOpFor = (def: FilterFieldDef): FilterOp =>
  def.kind === "number" ? ">=" : def.kind === "text" ? "contains" : "is";
const defaultValueFor = (def: FilterFieldDef): string =>
  def.kind === "boolean" ? "yes" : def.kind === "enum" ? def.options![0].value : "";

// Resolve a domain's numeric value for a number-kind field (null = not evaluable).
function filterFieldValue(d: DomainRow, field: FilterField): number | null {
  switch (field) {
    case "inbox_count": return d.inbox_count ?? 0;
    case "total_sent": return d.total_sent ?? 0;
    case "total_replied": return d.total_replied ?? 0;
    case "total_bounced": return d.total_bounced ?? 0;
    case "daily_limit_total": return d.daily_limit_total ?? 0;
    case "warmup_limit_total": return d.warmup_limit_total ?? 0;
    case "outlook_count": return d.outlook_count ?? 0;
    case "google_count": return d.google_count ?? 0;
    case "reply_rate": return (d.total_sent || 0) > 0 ? (d.total_replied || 0) / (d.total_sent || 1) * 100 : 0;
    case "bounce_rate": return (d.total_sent || 0) > 0 ? (d.total_bounced || 0) / (d.total_sent || 1) * 100 : 0;
    case "reply_10": return d.reply_10 ?? null;
    case "reply_15": return d.reply_15 ?? null;
    case "reply_30": return d.reply_30 ?? null;
    case "bounce_10": return d.bounce_10 ?? null;
    case "bounce_15": return d.bounce_15 ?? null;
    case "bounce_30": return d.bounce_30 ?? null;
    case "domain_age_days": {
      if (!d.domain_created_at) return null;
      const t = new Date(d.domain_created_at).getTime();
      return isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
    }
    case "warmup_days_left": {
      if (!d.domain_created_at) return null;
      const t = new Date(d.domain_created_at).getTime();
      return isNaN(t) ? null : Math.max(0, 21 - Math.floor((Date.now() - t) / 86400000));
    }
    default: return null;
  }
}

// Cross-row context for enum fields (both maps already live on the page).
interface FilterCtx {
  providerStatusMap: Record<string, { status: "active" | "canceled" }>;
  domainInstancesMap: Record<string, string[]>;
}

function evalCondition(d: DomainRow, c: FilterCondition, ctx: FilterCtx): boolean {
  if (c.value.trim() === "") return true; // unset condition → ignore
  const def = filterFieldDef(c.field);
  switch (def.kind) {
    case "number": {
      const target = parseFloat(c.value);
      if (isNaN(target)) return true;
      const v = filterFieldValue(d, c.field);
      if (v == null) return false; // not evaluable (no history/date) → cannot match
      switch (c.op) {
        case ">=": return v >= target;
        case ">": return v > target;
        case "=": return v === target;
        case "<": return v < target;
        case "<=": return v <= target;
        default: return true;
      }
    }
    case "boolean": {
      const want = c.value === "yes";
      const actual: boolean | null =
        c.field === "blacklisted" ? (d.blacklisted ?? null)
        : c.field === "spamhaus_dbl" ? (d.spamhaus_dbl ?? null)
        : d.warmup_status === "done"; // warmup_complete
      if (actual === null) return false; // never checked → matches neither Yes nor No
      return actual === want;
    }
    case "enum": {
      if (c.field === "provider_status") {
        const actual = ctx.providerStatusMap[`${d.instance}:${d.domain}`]?.status ?? "unknown";
        return c.op === "is_not" ? actual !== c.value : actual === c.value;
      }
      // instance_presence — where does this domain exist across all 4 instances?
      const present = (ctx.domainInstancesMap[d.domain] ?? [d.instance]).includes(c.value);
      return c.op === "is_not" ? !present : present;
    }
    case "text": {
      const needle = c.value.trim().toLowerCase();
      const hay = c.field === "tags_text"
        ? (d.tags || []).join(" ").toLowerCase()
        : (d.redirect_url || "").toLowerCase();
      const has = hay.includes(needle);
      return c.op === "not_contains" ? !has : has;
    }
  }
}

// --- Table columns (single source of truth for header, rows, grid template,
// and the show/hide toggle). `field` doubles as the sort key + visibility key.
// Domain is non-toggleable (always shown). ---
type ColField =
  | "domain" | "blacklisted" | "spamhaus_dbl" | "redirect_url" | "provider_status" | "instances" | "inbox_count" | "total_sent" | "total_replied"
  | "reply_rate" | "reply_trailing" | "total_bounced" | "bounce_rate"
  | "bounce_trailing" | "daily_limit" | "warmup_days";
const TABLE_COLUMNS: { field: ColField; label: string; align: string; width: string; toggleable: boolean }[] = [
  { field: "domain", label: "Domain", align: "text-left", width: "1fr", toggleable: false },
  { field: "blacklisted", label: "SURBL", align: "text-center", width: "80px", toggleable: true },
  { field: "spamhaus_dbl", label: "Spamhaus DBL", align: "text-center", width: "110px", toggleable: true },
  { field: "redirect_url", label: "Redirect URL", align: "text-left", width: "180px", toggleable: true },
  { field: "provider_status", label: "Provider", align: "text-center", width: "100px", toggleable: true },
  { field: "instances", label: "Instances", align: "text-center", width: "110px", toggleable: true },
  { field: "inbox_count", label: "Inboxes", align: "text-center", width: "90px", toggleable: true },
  { field: "total_sent", label: "Sent", align: "text-center", width: "70px", toggleable: true },
  { field: "total_replied", label: "Replied", align: "text-center", width: "70px", toggleable: true },
  { field: "reply_rate", label: "Reply Rate", align: "text-center", width: "80px", toggleable: true },
  { field: "reply_trailing", label: "Reply 10/15/30d", align: "text-center", width: "128px", toggleable: true },
  { field: "total_bounced", label: "Bounced", align: "text-center", width: "70px", toggleable: true },
  { field: "bounce_rate", label: "Bounce Rate", align: "text-center", width: "80px", toggleable: true },
  { field: "bounce_trailing", label: "Bounce 10/15/30d", align: "text-center", width: "128px", toggleable: true },
  { field: "daily_limit", label: "Daily", align: "text-center", width: "70px", toggleable: true },
  { field: "warmup_days", label: "Status", align: "text-center", width: "90px", toggleable: true },
];

interface InstanceSyncProgress {
  slug: BisonInstanceSlug;
  label: string;
  synced: number;
  page: number;
  lastPage: number;
  status: "pending" | "running" | "done" | "failed";
  error?: string;
  // Timestamps for the live throughput + freshness indicator. Not persisted;
  // reset every time handleSync starts a new run.
  startedAt?: number;
  lastUpdateAt?: number;
}

// ---------- Tag Multi-Select Dropdown ----------
function TagFilterDropdown({
  allTags,
  selected,
  onChange,
  mode,
  onModeChange,
}: {
  allTags: string[];
  selected: string[];
  onChange: (tags: string[]) => void;
  mode: "AND" | "OR";
  onModeChange: (m: "AND" | "OR") => void;
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

  // Comma-separated search: typing "fcs, jpc, pps" narrows the list to any
  // tag whose name contains ANY of those terms. Single search (no commas)
  // behaves like a plain substring match.
  const searchTerms = useMemo(
    () =>
      search
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    [search],
  );
  const filtered = useMemo(() => {
    if (searchTerms.length === 0) return allTags;
    return allTags.filter((t) => {
      const lower = t.toLowerCase();
      return searchTerms.some((term) => lower.includes(term));
    });
  }, [allTags, searchTerms]);

  // Drag-select over the visible tag rows. Mirrors the pattern used in the
  // main domain table (search "handleDragStart" in this file). Mousedown on
  // a row starts a drag whose "select vs deselect" mode is the opposite of
  // that row's current state; hovering subsequent rows applies the same mode.
  const isDragging = useRef(false);
  const dragMode = useRef<"select" | "deselect">("select");
  const dragStartIdx = useRef(-1);
  const dragLastIdx = useRef(-1);

  useEffect(() => {
    const up = () => {
      isDragging.current = false;
      dragStartIdx.current = -1;
      dragLastIdx.current = -1;
    };
    document.addEventListener("mouseup", up);
    return () => document.removeEventListener("mouseup", up);
  }, []);

  const applyRangeSelection = (fromIdx: number, toIdx: number, list: string[]) => {
    const [lo, hi] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
    const range = list.slice(lo, hi + 1);
    const next = new Set(selected);
    for (const t of range) {
      if (dragMode.current === "select") next.add(t);
      else next.delete(t);
    }
    onChange([...next]);
  };

  const onRowMouseDown = (idx: number, tag: string) => {
    isDragging.current = true;
    dragStartIdx.current = idx;
    dragLastIdx.current = idx;
    const wasSelected = selected.includes(tag);
    dragMode.current = wasSelected ? "deselect" : "select";
    // Apply to the starting row immediately.
    const next = new Set(selected);
    if (dragMode.current === "select") next.add(tag);
    else next.delete(tag);
    onChange([...next]);
  };

  const onRowMouseEnter = (idx: number) => {
    if (!isDragging.current || idx === dragLastIdx.current) return;
    dragLastIdx.current = idx;
    applyRangeSelection(dragStartIdx.current, idx, filtered);
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
        {selected.length > 1 && (
          <span className="text-[10px] font-medium uppercase tracking-wide opacity-70">
            {mode}
          </span>
        )}
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1.5 z-50 w-64 rounded-xl border bg-popover shadow-lg overflow-hidden">
          {/* AND / OR toggle */}
          <div className="flex items-center gap-1 px-3 py-2 border-b">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground mr-1">Match</span>
            <button
              onClick={() => onModeChange("OR")}
              className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                mode === "OR"
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
              }`}
              title="Show domains carrying ANY of the selected tags"
            >
              Any (OR)
            </button>
            <button
              onClick={() => onModeChange("AND")}
              className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                mode === "AND"
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
              }`}
              title="Show domains carrying ALL of the selected tags"
            >
              All (AND)
            </button>
          </div>

          {/* Search — supports comma-separated multi-term filtering */}
          <div className="flex items-center gap-2 px-3 py-2 border-b">
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tags… (comma-separated OK)"
              className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
            />
            {search && (
              <button onClick={() => setSearch("")}>
                <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
              </button>
            )}
          </div>

          {/* Bulk actions row */}
          {(filtered.length > 0 || selected.length > 0) && (
            <div className="flex items-center justify-between px-3 py-1.5 text-xs border-b">
              {filtered.length > 0 ? (
                <button
                  onClick={() => {
                    const next = new Set(selected);
                    for (const t of filtered) next.add(t);
                    onChange([...next]);
                  }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  Select all {searchTerms.length > 0 ? `matches (${filtered.length})` : ""}
                </button>
              ) : <span />}
              {selected.length > 0 && (
                <button
                  onClick={() => onChange([])}
                  className="text-muted-foreground hover:text-foreground"
                >
                  Clear ({selected.length})
                </button>
              )}
            </div>
          )}

          {/* Tag list — drag to select/deselect a range */}
          <div className="max-h-64 overflow-y-auto select-none">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground text-center">No tags found</div>
            ) : (
              filtered.map((tag, idx) => (
                <div
                  key={tag}
                  onMouseDown={(e) => { e.preventDefault(); onRowMouseDown(idx, tag); }}
                  onMouseEnter={() => onRowMouseEnter(idx)}
                  onClick={(e) => {
                    // A simple click without dragging is handled by mousedown
                    // already — swallow to prevent double-toggle.
                    e.preventDefault();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left transition-colors cursor-pointer"
                >
                  <div className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                    selected.includes(tag) ? "bg-primary border-primary" : "border-border"
                  }`}>
                    {selected.includes(tag) && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                  </div>
                  <span className="truncate">{tag}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );

  // Note: onRowMouseDown toggles the starting row (that's why plain-click
  // still works — a click IS a mousedown+mouseup with no enter). We swallow
  // the onClick handler to avoid the row's default click semantics doubling
  // that toggle. The two usages of TagFilterDropdown both receive `mode`
  // + `onModeChange` from the parent DeliverabilityPageInner.
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
  const { role } = useAuth();
  const isAdmin = role === "admin";
  const { instancesQuery, instances } = useInstance();
  // Cached Inboxing/MilkBox/ScaledMail lifecycle map by "instance:domain".
  const { statuses: providerStatusMap, mutate: mutateProviderStatus } = useProviderStatus(instancesQuery);
  // Cross-instance presence: which of the 4 Bison instances each domain
  // exists in (all instances, regardless of the sidebar switcher).
  const { domainInstancesMap, mutate: mutateDomainInstances } = useDomainInstances();
  const [bisonTags, setBisonTags] = useState<string[]>([]);
  const [domains, setDomains] = useState<DomainRow[]>([]);
  // Days of snapshot history collected (drives the trailing-rate warm-up note)
  const [trailingDaysCollected, setTrailingDaysCollected] = useState(0);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncProgresses, setSyncProgresses] = useState<InstanceSyncProgress[] | null>(null);
  // Ticks every second while a sync is running so the "N s ago" freshness
  // text and the throughput rate re-render live. No-op when idle.
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!syncing) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [syncing]);
  const [syncStats, setSyncStats] = useState<{ inboxCount: number; domainCount: number } | null>(null);
  const [tagFilters, setTagFilters] = useState<string[]>(() => {
    const t = searchParams.get("tags");
    return t ? t.split(",").map((s) => s.trim()).filter(Boolean) : [];
  });
  // How multiple tag filters combine. Default OR matches user expectation:
  // "show any domain carrying at least one of these tags". AND is the strict
  // intersection — used to be the only mode and can be turned on inside the
  // Tags dropdown.
  const [tagMatchMode, setTagMatchMode] = useState<"AND" | "OR">("OR");
  const [warmupFilter, setWarmupFilter] = useState<"all" | "open" | "done">("open");
  const [warmupTypeFilter, setWarmupTypeFilter] = useState<"all" | "outlook" | "google">("all");
  const [activeTab, setActiveTab] = useState<"inboxes" | "warmup">("inboxes");
  const [savedPage, setSavedPage] = useState<number | null>(null);
  const [domainSearch, setDomainSearch] = useState("");
  const [redirectSearch, setRedirectSearch] = useState("");
  const [warmupSearch, setWarmupSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "outlook" | "google">("all");
  const [showFlagged, setShowFlagged] = useState(() => searchParams.get("flagged") === "true");
  const [showHealthy, setShowHealthy] = useState(() => searchParams.get("healthy") === "true");
  const [showBlacklisted, setShowBlacklisted] = useState(() => searchParams.get("blacklisted") === "true");
  const [showNotBlacklisted, setShowNotBlacklisted] = useState(() => searchParams.get("blacklisted") === "false");
  const [showSpamhausListed, setShowSpamhausListed] = useState(() => searchParams.get("spamhaus") === "true");
  const [showSpamhausClean, setShowSpamhausClean] = useState(() => searchParams.get("spamhaus") === "false");
  const [showMultiClient, setShowMultiClient] = useState(() => searchParams.get("multiClient") === "true");
  const [flagSubFilter, setFlagSubFilter] = useState<"all" | "reply" | "bounce">("all");
  const [showReserve, setShowReserve] = useState(false);
  // Provider lifecycle status filter (Inboxing / MilkBox). Cache populated by
  // /api/cron/provider-domain-status-check daily; domains without a cache
  // row (missing the Inboxing/Milkbox tag, or never checked yet) render as
  // "Unknown".
  const [providerStatusFilter, setProviderStatusFilter] = useState<"all" | "active" | "canceled" | "unknown">("all");
  const [warmupDaysFilter, setWarmupDaysFilter] = useState<string>("all");
  const [warmupDaysFrom, setWarmupDaysFrom] = useState("");
  const [warmupDaysTo, setWarmupDaysTo] = useState("");
  const [showAssigned, setShowAssigned] = useState(false);
  // Multi-condition numeric filter (up to 5, combined via AND or OR)
  const [filterConditions, setFilterConditions] = useState<FilterCondition[]>([]);
  const [filterMatchMode, setFilterMatchMode] = useState<"all" | "any">("all");
  const [showFilterBuilder, setShowFilterBuilder] = useState(false);
  const filterIdRef = useRef(1);
  // Column show/hide (persisted). Missing key = visible.
  const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>({});
  const [showColumnMenu, setShowColumnMenu] = useState(false);
  const [sortField, setSortField] = useState<"domain" | "blacklisted" | "spamhaus_dbl" | "redirect_url" | "provider_status" | "instances" | "inbox_count" | "total_sent" | "total_replied" | "reply_rate" | "reply_trailing" | "total_bounced" | "bounce_rate" | "bounce_trailing" | "daily_limit" | "warmup_days" | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [attachDialogOpen, setAttachDialogOpen] = useState(false);
  const [conformTagsOpen, setConformTagsOpen] = useState(false);
  // Manual trigger for the Inboxing/MilkBox/ScaledMail domain-status check —
  // one row per provider in the progress panel at the top of the page.
  interface ProviderCheckRow {
    provider: string;
    label: string;
    state: "running" | "done" | "error";
    scanned?: number;
    canceled?: number;
    failed?: number;
    error?: string;
  }
  const [providerChecking, setProviderChecking] = useState(false);
  const [providerCheckRows, setProviderCheckRows] = useState<ProviderCheckRow[] | null>(null);
  const [changeRedirectOpen, setChangeRedirectOpen] = useState(false);
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  // Live progress for the move-to-instance workflow — rendered in the panel
  // at the top of the page (per-domain outcomes, never-stuck error surfacing).
  interface MoveProgressState {
    id: number;
    targetLabel: string;
    connectionName: string;
    done: number;
    total: number;
    counts: { done: number; uploading: number; skipped: number; failed: number };
    failures: { domain: string; stage?: string; error: string }[];
    uploading: string[];
    running: boolean;
    queued: boolean;
  }
  const [moveProgress, setMoveProgress] = useState<MoveProgressState | null>(null);
  const [clientTags, setClientTags] = useState<Set<string>>(new Set());
  const [selectedDomains, setSelectedDomains] = useState<Set<string>>(new Set());
  // Stable array of the selected domains — passed to dialogs so their effects
  // don't re-run (and re-discover) on every render from a fresh Array.from(...).
  const selectedDomainsList = useMemo(() => Array.from(selectedDomains), [selectedDomains]);
  const [bulkTagMode, setBulkTagMode] = useState<"add" | "remove" | null>(null);
  const [showBulkDelete, setShowBulkDelete] = useState(false);
  const [showAttachCampaigns, setShowAttachCampaigns] = useState(false);
  const [showRemoveFromCampaigns, setShowRemoveFromCampaigns] = useState(false);

  // Background attach state.
  //
  // Progress panels are LISTS of independent runs, not single slots: starting
  // a new attach used to REPLACE the previous panel mid-flight (and corrupt
  // the running loop via shared refs). Now every run gets its own id + panel
  // stacked under existing ones, updated only by its own loop, and removed
  // only by its own Dismiss button — never automatically.
  interface SkippedInbox { email: string; domain: string; reason: string; retryable?: boolean }
  interface AttachJob { campaign: string; status: "pending" | "running" | "done" | "error"; newly: number; existing: number; failed?: number; rateLimited?: number; failedInboxes?: SkippedInbox[]; error?: string }
  interface AttachRun {
    id: number;
    domains: string[];
    campaigns: { id: number; name: string; instance: BisonInstanceSlug }[];
    jobs: AttachJob[];
    running: boolean;
    queued: boolean;
  }
  const [attachRuns, setAttachRuns] = useState<AttachRun[]>([]);
  const runIdRef = useRef(1); // shared id sequence for every stacked-panel kind
  const [showSkippedAttach, setShowSkippedAttach] = useState<string | null>(null); // "runId:jobIndex"

  // One-at-a-time execution for Bison-heavy background runs (attach / tag /
  // move). Running several at once stacks onto Bison's per-minute rate limits
  // and everything slows down or fails — so new runs render immediately as
  // "Queued" and start only when the previous run finishes. Dismissing a
  // queued run cancels it before it ever hits the API.
  const bisonRunQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const dismissedRunsRef = useRef<Set<number>>(new Set());
  const enqueueBisonRun = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const run = bisonRunQueueRef.current.then(fn, fn);
    bisonRunQueueRef.current = run.then(() => undefined, () => undefined);
    return run;
  }, []);

  // Background tag + campaign combo state — same stacked-run model.
  interface TagCampaignRun {
    id: number;
    info: TagApplyInfo;
    tagStatus: "running" | "done" | "error";
    tagLabel: string;
    tagAffected?: number;
    tagFailed?: number;
    tagFailedInboxes?: { email: string; domain: string; reason: string }[];
    tagError?: string;
    campaignJobs: AttachJob[];
    campaignsDone: boolean;
    domains: string[];
    sheetStatus?: "running" | "done" | "error" | "skipped";
    sheetLabel?: string;
    sheetAdded?: number;
    sheetDuplicates?: number;
    sheetError?: string;
    retry: { attempt: number; total: number; countdown: number } | null;
    queued: boolean;
  }
  const [tagCampaignRuns, setTagCampaignRuns] = useState<TagCampaignRun[]>([]);
  // Per-run retry token: cancels a pending auto-retry countdown for THAT run
  // when the user hits "Retry now" or Dismiss on it.
  const tagRetryTokensRef = useRef<Map<number, number>>(new Map());
  const [domainsCopied, setDomainsCopied] = useState<number | null>(null);      // runId
  const [showSkippedList, setShowSkippedList] = useState<number | null>(null);  // runId
  const [skippedCopied, setSkippedCopied] = useState<number | null>(null);      // runId
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exportCopied, setExportCopied] = useState(false);
  const [showSendToSheet, setShowSendToSheet] = useState(false);

  // Standalone sheet append (Whitelist button) — stacked runs too.
  interface SheetAppendJob { id: number; status: "running" | "done" | "error"; label: string; added?: number; duplicates?: number; error?: string; whitelist?: string }
  const [sheetAppendJobs, setSheetAppendJobs] = useState<SheetAppendJob[]>([]);

  // Bulk limit update state
  const [limitDialog, setLimitDialog] = useState<{ type: "daily" | "warmup"; domains: string[] } | null>(null);

  // Sync selected domains state
  interface SyncSelectedJob { status: "running" | "done" | "error"; synced: number; totalDomains: number; error?: string }
  const [syncSelectedJob, setSyncSelectedJob] = useState<SyncSelectedJob | null>(null);

  // Check redirects job state
  interface RedirectCheckJob { status: "running" | "done" | "error"; checked: number; total: number; redirects: number; error?: string }
  const [redirectCheckJob, setRedirectCheckJob] = useState<RedirectCheckJob | null>(null);

  // Check blacklist job state
  interface BlacklistCheckJob { status: "running" | "done" | "error"; checked: number; total: number; listed: number; inconclusive: number; error?: string }
  const [blacklistCheckJob, setBlacklistCheckJob] = useState<BlacklistCheckJob | null>(null);

  // Check Spamhaus DBL job state
  interface SpamhausCheckJob { status: "running" | "done" | "error"; checked: number; total: number; listed: number; inconclusive: number; error?: string }
  const [spamhausCheckJob, setSpamhausCheckJob] = useState<SpamhausCheckJob | null>(null);
  const [limitInput, setLimitInput] = useState("");
  interface LimitJob { type: "daily" | "warmup"; limit: number; status: "running" | "done" | "error"; updated?: number; total?: number; error?: string }
  const [limitJob, setLimitJob] = useState<LimitJob | null>(null);

  // Drag-to-select state
  const isDragging = useRef(false);
  const dragSelectMode = useRef<boolean>(true); // true = selecting, false = deselecting


  // Patch one attach run by id (no-op if the run was dismissed).
  const patchAttachRun = useCallback((runId: number, patch: (run: AttachRun) => AttachRun) => {
    setAttachRuns((prev) => prev.map((r) => (r.id === runId ? patch(r) : r)));
  }, []);

  // Run the attach for one campaign (with 3x whole-request retry on hard
  // failure) and write the result — including per-inbox skip reasons — into
  // its run's job at jobIndex. Shared by the initial run and "Retry skipped".
  // Domains are passed explicitly (per-run closure), never via a shared ref —
  // a second concurrent run must not change what the first is attaching.
  const runAttachForCampaign = useCallback(async (
    runId: number,
    campaign: { id: number; name: string; instance: BisonInstanceSlug },
    jobIndex: number,
    domains: string[],
  ) => {
    const patchJob = (patch: Partial<AttachJob>) =>
      patchAttachRun(runId, (r) => ({ ...r, jobs: r.jobs.map((j, idx) => (idx === jobIndex ? { ...j, ...patch } : j)) }));
    patchJob({ status: "running" });
    let success = false;
    let lastError = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`/api/deliverability/attach-domains-to-campaign?instance=${campaign.instance}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ campaign_id: campaign.id, domains }),
        });
        const data = await res.json();
        if (res.ok) {
          patchJob({
            status: "done",
            newly: data.newly_attached || 0,
            existing: data.already_attached || 0,
            failed: data.failed || 0,
            rateLimited: data.rateLimited || 0,
            failedInboxes: data.failedInboxes || [],
          });
          success = true;
          break;
        }
        lastError = data.error || `HTTP ${res.status}`;
      } catch (e) {
        lastError = e instanceof Error ? e.message : "Network error";
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
    }
    if (!success) patchJob({ status: "error", error: lastError });
  }, [patchAttachRun]);

  const startBackgroundAttach = useCallback(async (campaigns: { id: number; name: string; instance: BisonInstanceSlug }[], domains: string[]) => {
    const runId = runIdRef.current++;
    const run: AttachRun = {
      id: runId,
      domains,
      campaigns,
      jobs: campaigns.map((c) => ({ campaign: c.name, status: "pending" as const, newly: 0, existing: 0 })),
      running: false,
      queued: true,
    };
    // Append below any existing panels — never replaces a previous run.
    setAttachRuns((prev) => [...prev, run]);
    setSelectedDomains(new Set());

    await enqueueBisonRun(async () => {
      if (dismissedRunsRef.current.has(runId)) return; // dismissed while queued
      patchAttachRun(runId, (r) => ({ ...r, queued: false, running: true }));
      try {
        for (let i = 0; i < campaigns.length; i++) {
          if (dismissedRunsRef.current.has(runId)) return;
          await runAttachForCampaign(runId, campaigns[i], i, domains);
        }
      } finally {
        patchAttachRun(runId, (r) => ({ ...r, running: false }));
      }
    });
  }, [runAttachForCampaign, patchAttachRun, enqueueBisonRun]);

  // Re-run attach for just the campaigns in ONE run that had retryable
  // (rate-limit / transient) skips. Already-attached inboxes are filtered
  // server-side, so this only re-attempts the ones that didn't make it.
  const retrySkippedAttach = async (run: AttachRun) => {
    setShowSkippedAttach(null);
    patchAttachRun(run.id, (r) => ({ ...r, queued: true }));
    await enqueueBisonRun(async () => {
      if (dismissedRunsRef.current.has(run.id)) return;
      patchAttachRun(run.id, (r) => ({ ...r, queued: false, running: true }));
      try {
        for (let i = 0; i < run.campaigns.length; i++) {
          if (dismissedRunsRef.current.has(run.id)) return;
          if ((run.jobs[i]?.rateLimited ?? 0) > 0) await runAttachForCampaign(run.id, run.campaigns[i], i, run.domains);
        }
      } finally {
        patchAttachRun(run.id, (r) => ({ ...r, running: false }));
      }
    });
  };

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

  const domainsSeqRef = useRef(0);
  const statsSeqRef = useRef(0);

  const loadDomains = useCallback(async () => {
    const seq = ++domainsSeqRef.current;
    setLoading(true);
    setDomains([]);
    try {
      // Domains + trailing rates in parallel; trailing is best-effort.
      const [res, trailingRes] = await Promise.all([
        fetch(`/api/deliverability/domains?${instancesQuery}`, { cache: "no-store" }),
        fetch(`/api/deliverability/trailing?${instancesQuery}`, { cache: "no-store" }).catch(() => null),
      ]);
      const data = await res.json();
      if (seq !== domainsSeqRef.current) return;

      // Build a domain → trailing-rates map (keyed by domain; domains are unique per view).
      const trailingByDomain = new Map<string, { reply_10: number | null; reply_15: number | null; reply_30: number | null; bounce_10: number | null; bounce_15: number | null; bounce_30: number | null }>();
      if (trailingRes && trailingRes.ok) {
        try {
          const t = await trailingRes.json();
          for (const r of (t?.rates || []) as { domain: string; reply_10: number | null; reply_15: number | null; reply_30: number | null; bounce_10: number | null; bounce_15: number | null; bounce_30: number | null }[]) {
            trailingByDomain.set(r.domain, { reply_10: r.reply_10, reply_15: r.reply_15, reply_30: r.reply_30 ?? null, bounce_10: r.bounce_10, bounce_15: r.bounce_15, bounce_30: r.bounce_30 ?? null });
          }
          setTrailingDaysCollected(typeof t?.daysCollected === "number" ? t.daysCollected : 0);
        } catch { /* ignore trailing parse errors */ }
      }

      const merged: DomainRow[] = (Array.isArray(data) ? data : []).map((d: DomainRow) => {
        const t = trailingByDomain.get(d.domain);
        return t ? { ...d, ...t } : d;
      });
      setDomains(merged);
    } catch { /* ignore */ } finally {
      if (seq === domainsSeqRef.current) setLoading(false);
    }
  }, [instancesQuery]);

  const loadStats = useCallback(async () => {
    const seq = ++statsSeqRef.current;
    setSyncStats(null);
    try {
      const res = await fetch(`/api/deliverability/sync?${instancesQuery}`, { cache: "no-store" });
      const data = await res.json();
      if (seq !== statsSeqRef.current) return;
      setSyncStats(data);
    } catch {/* ignore */}
  }, [instancesQuery]);

  // Pull the full tag list straight from each selected Bison instance — the
  // authoritative source — so the filter dropdown shows every tag that exists,
  // not just ones currently applied to loaded domains.
  const loadTags = useCallback(async () => {
    try {
      const results = await Promise.all(
        instances.map((inst) =>
          fetch(`/api/deliverability/bulk-tags?instance=${encodeURIComponent(inst.slug)}`)
            .then((r) => r.json())
            .catch(() => ({ tags: [] }))
        )
      );
      const set = new Set<string>();
      for (const r of results) {
        for (const t of (r?.tags || []) as { name?: string }[]) {
          if (t?.name) set.add(t.name);
        }
      }
      setBisonTags(Array.from(set));
    } catch {/* ignore */}
  }, [instances]);

  // Re-runnable core of the tag + campaign + sheet operation. Returns true only
  // if every step succeeded. Partial skips (e.g. disconnected inboxes reported
  // as tagFailed) are NOT failures and don't trigger a retry.
  const runTagCampaignOnce = useCallback(async (info: TagApplyInfo, runId: number): Promise<boolean> => {
    const tagLabel = `${info.mode === "add" ? "Adding" : "Removing"} ${info.tagNames.join(", ")}`;
    const campaignJobs: AttachJob[] = info.campaigns.map((c) => ({ campaign: c.name, status: "pending" as const, newly: 0, existing: 0 }));
    // Patch THIS run only — dismissed runs no-op, concurrent runs untouched.
    const patchRun = (patch: (r: TagCampaignRun) => TagCampaignRun) =>
      setTagCampaignRuns((prev) => prev.map((r) => (r.id === runId ? patch(r) : r)));
    // Reset the run's panel content for this attempt (fresh run or retry).
    patchRun((r) => ({
      ...r,
      tagStatus: "running", tagLabel, campaignJobs, campaignsDone: info.campaigns.length === 0, domains: info.domains,
      tagAffected: undefined, tagFailed: undefined, tagFailedInboxes: undefined, tagError: undefined,
      sheetStatus: info.sheetAppend ? "running" : "skipped",
      sheetLabel: info.sheetAppend ? `Sending to ${info.sheetAppend.clientTag} sheet...` : undefined,
      sheetAdded: undefined, sheetDuplicates: undefined, sheetError: undefined,
    }));
    setSelectedDomains(new Set());

    let tagOk = true;
    let campaignsOk = true;
    let sheetOk = true;

    // Run tags + campaigns + sheet append in parallel
    const tagPromise = fetch("/api/deliverability/bulk-tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: info.mode, tagNames: info.tagNames, domains: info.domains }),
    }).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      patchRun((r) => ({ ...r, tagStatus: "done", tagAffected: data.inboxesAffected || 0, tagFailed: data.failed || 0, tagFailedInboxes: data.failedInboxes || [] }));
    }).catch((err) => {
      tagOk = false;
      patchRun((r) => ({ ...r, tagStatus: "error", tagError: err instanceof Error ? err.message : "Failed" }));
    });

    const campaignPromise = (async () => {
      for (let i = 0; i < info.campaigns.length; i++) {
        const campaign = info.campaigns[i];
        patchRun((r) => ({
          ...r,
          campaignJobs: r.campaignJobs.map((j, idx) => idx === i ? { ...j, status: "running" } : j),
        }));

        try {
          const res = await fetch(`/api/deliverability/attach-domains-to-campaign?instance=${campaign.instance}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ campaign_id: campaign.id, domains: info.domains }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          patchRun((r) => ({
            ...r,
            campaignJobs: r.campaignJobs.map((j, idx) => idx === i ? { ...j, status: "done", newly: data.newly_attached || 0, existing: data.already_attached || 0, failed: data.failed || 0 } : j),
          }));
        } catch (err) {
          campaignsOk = false;
          patchRun((r) => ({
            ...r,
            campaignJobs: r.campaignJobs.map((j, idx) => idx === i ? { ...j, status: "error", error: err instanceof Error ? err.message : "Failed" } : j),
          }));
        }
      }
      patchRun((r) => ({ ...r, campaignsDone: true }));
    })();

    const sheetPromise = (async () => {
      if (!info.sheetAppend) return;
      try {
        const res = await fetch("/api/deliverability/send-to-sheet", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domains: info.domains, clientTag: info.sheetAppend.clientTag }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed");
        // Also queue these domains for the daily 6:30am PST whitelist email.
        // Best-effort — a queue failure shouldn't fail the sheet append.
        let queuedLabel = "";
        try {
          const qRes = await fetch("/api/deliverability/whitelist/queue", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ domains: info.domains, clientTag: info.sheetAppend.clientTag }),
          });
          const qData = await qRes.json();
          if (qRes.ok && qData.queued > 0) queuedLabel = ` · ${qData.queued} queued for whitelist email`;
        } catch {/* ignore queue errors */}
        patchRun((r) => ({
          ...r, sheetStatus: "done",
          sheetLabel: `Added to "${data.sheetName}" Domains tab${queuedLabel}`,
          sheetAdded: data.added, sheetDuplicates: data.duplicates,
        }));
      } catch (err) {
        sheetOk = false;
        patchRun((r) => ({
          ...r, sheetStatus: "error",
          sheetLabel: "Sheet append failed",
          sheetError: err instanceof Error ? err.message : "Failed",
        }));
      }
    })();

    await Promise.all([tagPromise, campaignPromise, sheetPromise]);
    loadDomains();
    loadTags();
    return tagOk && campaignsOk && sheetOk;
  }, [loadDomains, loadTags]);

  // After a failed run, auto-retry up to 3 times, 30s apart. Tokens are
  // per-run: "Retry now" / Dismiss on a run bumps ITS token, so a stale
  // countdown or scheduling no-ops without touching other stacked runs.
  const scheduleTagAutoRetry = useCallback(async (info: TagApplyInfo, attempt: number, token: number, runId: number) => {
    const patchRetry = (retry: TagCampaignRun["retry"]) =>
      setTagCampaignRuns((prev) => prev.map((r) => (r.id === runId ? { ...r, retry } : r)));
    for (let s = 30; s > 0; s--) {
      if (token !== tagRetryTokensRef.current.get(runId)) return;
      patchRetry({ attempt, total: 3, countdown: s });
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (token !== tagRetryTokensRef.current.get(runId)) return;
    patchRetry({ attempt, total: 3, countdown: 0 });
    // Through the shared queue — a retry must not run alongside another
    // Bison-heavy process either.
    const ok = await enqueueBisonRun(() => runTagCampaignOnce(info, runId));
    if (token !== tagRetryTokensRef.current.get(runId)) return;
    patchRetry(null);
    if (!ok && attempt < 3) scheduleTagAutoRetry(info, attempt + 1, token, runId);
  }, [runTagCampaignOnce, enqueueBisonRun]);

  // Re-run one stacked run in place (manual "Retry" on its panel).
  const retryTagCampaignRun = useCallback(async (runId: number, info: TagApplyInfo) => {
    const token = (tagRetryTokensRef.current.get(runId) ?? 0) + 1;
    tagRetryTokensRef.current.set(runId, token);
    setTagCampaignRuns((prev) => prev.map((r) => (r.id === runId ? { ...r, retry: null, queued: true } : r)));
    const ok = await enqueueBisonRun(async () => {
      if (dismissedRunsRef.current.has(runId)) return true;
      setTagCampaignRuns((prev) => prev.map((r) => (r.id === runId ? { ...r, queued: false } : r)));
      return runTagCampaignOnce(info, runId);
    });
    if (token !== tagRetryTokensRef.current.get(runId)) return;
    if (!ok) scheduleTagAutoRetry(info, 1, token, runId);
  }, [runTagCampaignOnce, scheduleTagAutoRetry, enqueueBisonRun]);

  const startBackgroundTagCampaign = useCallback(async (info: TagApplyInfo) => {
    const runId = runIdRef.current++;
    const token = 1;
    tagRetryTokensRef.current.set(runId, token);
    // Append a new panel below any existing ones — never replaces a prior
    // run. Starts as "Queued" and executes when the shared queue frees up.
    setTagCampaignRuns((prev) => [...prev, {
      id: runId,
      info,
      tagStatus: "running",
      tagLabel: `${info.mode === "add" ? "Adding" : "Removing"} ${info.tagNames.join(", ")}`,
      campaignJobs: [],
      campaignsDone: info.campaigns.length === 0,
      domains: info.domains,
      retry: null,
      queued: true,
    }]);
    const ok = await enqueueBisonRun(async () => {
      if (dismissedRunsRef.current.has(runId)) return true; // dismissed while queued
      setTagCampaignRuns((prev) => prev.map((r) => (r.id === runId ? { ...r, queued: false } : r)));
      return runTagCampaignOnce(info, runId);
    });
    if (token !== tagRetryTokensRef.current.get(runId)) return;
    if (!ok) scheduleTagAutoRetry(info, 1, token, runId);
  }, [runTagCampaignOnce, scheduleTagAutoRetry, enqueueBisonRun]);

  const startBackgroundSheetAppend = useCallback(async (doms: string[], clientTag: string) => {
    const jobId = runIdRef.current++;
    const patchJob = (patch: Partial<SheetAppendJob>) =>
      setSheetAppendJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, ...patch } : j)));
    // Stacked: appended below existing panels, dismissed only manually.
    setSheetAppendJobs((prev) => [...prev, { id: jobId, status: "running", label: `Whitelisting ${doms.length} domains for ${clientTag}...` }]);
    setSelectedDomains(new Set());
    try {
      const res = await fetch("/api/deliverability/send-to-sheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domains: doms, clientTag }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      // Queue these domains for the daily 6:30am PST whitelist email — this is
      // the "Whitelist" button. Deferred (not sent now) so a day's worth of
      // domains go out in one batch. Surface the result; a queue failure
      // doesn't undo the successful sheet append.
      let whitelist = "";
      try {
        const wRes = await fetch("/api/deliverability/whitelist/queue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domains: doms, clientTag }),
        });
        const wData = await wRes.json();
        if (wRes.ok) {
          whitelist = wData.queued > 0
            ? `${wData.queued} queued for 6:30 AM PST whitelist email`
            : "Nothing new to email (already queued/sent)";
          if (wData.queued > 0 && wData.skipped > 0) whitelist += ` · ${wData.skipped} already queued`;
        } else {
          whitelist = `Queue failed: ${wData.error || "unknown"}`;
        }
      } catch (e) {
        whitelist = `Queue failed: ${e instanceof Error ? e.message : "error"}`;
      }
      patchJob({
        status: "done",
        label: `Added to "${data.sheetName}" Domains tab`,
        added: data.added, duplicates: data.duplicates, whitelist,
      });
    } catch (err) {
      patchJob({
        status: "error",
        label: "Whitelist failed",
        error: err instanceof Error ? err.message : "Failed",
      });
    }
  }, []);

  useEffect(() => {
    loadDomains();
    loadStats();
    loadTags();
  }, [loadDomains, loadStats, loadTags]);

  // Fires the same check the daily cron runs — every domain tagged
  // Inboxing/MilkBox/ScaledMail gets its live status pulled from the
  // provider's API. One request per provider, all three in parallel, each
  // updating its own row in the progress panel.
  const handleProviderCheck = async () => {
    if (providerChecking) return;
    setProviderChecking(true);
    const providers: { provider: string; label: string }[] = [
      { provider: "inboxing", label: "Inboxing" },
      { provider: "milkbox", label: "MilkBox" },
      { provider: "scaledmail", label: "ScaledMail" },
    ];
    setProviderCheckRows(providers.map((p) => ({ ...p, state: "running" as const })));
    const patchRow = (provider: string, patch: Partial<ProviderCheckRow>) =>
      setProviderCheckRows((rows) => (rows ? rows.map((r) => (r.provider === provider ? { ...r, ...patch } : r)) : rows));
    try {
      await Promise.all(
        providers.map(async ({ provider }) => {
          try {
            const res = await fetch("/api/deliverability/provider-status-check", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ provider }),
            });
            const text = await res.text();
            let d: { scanned?: number; canceled?: number; failed?: number; error?: string } | null = null;
            try { d = text ? JSON.parse(text) : null; } catch { /* non-JSON (timeout page) */ }
            if (!d || !res.ok || d.error) {
              patchRow(provider, { state: "error", error: d?.error || (res.status >= 500 ? "server timed out" : `HTTP ${res.status}`) });
            } else {
              patchRow(provider, { state: "done", scanned: d.scanned ?? 0, canceled: d.canceled ?? 0, failed: d.failed ?? 0 });
            }
          } catch (e) {
            patchRow(provider, { state: "error", error: e instanceof Error ? e.message : "network error" });
          }
        }),
      );
      // Refresh BOTH stores the table reads from: the domain rows AND the
      // provider-status SWR map (revalidateIfStale is off, so without an
      // explicit mutate the Provider column keeps rendering the pre-check
      // snapshot for up to 5 minutes).
      await Promise.all([loadDomains(), mutateProviderStatus()]);
    } finally {
      setProviderChecking(false);
    }
  };

  // Drives the batched move-to-instance apply. The dialog only collects the
  // job; all progress lives in the top panel so it's visible page-wide and
  // survives the dialog closing. Small batches (4 domains/request) keep each
  // request far under the serverless timeout even while it polls for sender
  // arrival on the target.
  const runMoveDomains = async (job: MoveJob) => {
    const BATCH = 4;
    const counts = { done: 0, uploading: 0, skipped: 0, failed: 0 };
    const failures: { domain: string; stage?: string; error: string }[] = [];
    const uploading: string[] = [];
    const moveId = runIdRef.current++;
    const base = {
      id: moveId,
      targetLabel: INSTANCE_SHORT_LABELS[job.targetInstance],
      connectionName: job.connectionName,
      total: job.domains.length,
    };
    setMoveProgress({ ...base, done: 0, counts: { ...counts }, failures: [], uploading: [], running: false, queued: true });
    await enqueueBisonRun(async () => {
    if (dismissedRunsRef.current.has(moveId)) return; // cancelled while queued
    setMoveProgress((prev) => (prev ? { ...prev, queued: false, running: true } : prev));
    try {
      for (let i = 0; i < job.domains.length; i += BATCH) {
        const batch = job.domains.slice(i, i + BATCH);
        try {
          const res = await fetch("/api/deliverability/move-domains", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              dryRun: false,
              domains: batch,
              targetInstance: job.targetInstance,
              platformConnectionId: job.platformConnectionId,
            }),
          });
          // JSON-safe parse — a serverless timeout returns an HTML page.
          const text = await res.text();
          let d: { error?: string; results?: { domain: string; status: string; stage?: string; error?: string }[] } | null = null;
          try { d = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
          if (!d || !res.ok || d.error) {
            const why = !d
              ? (res.status >= 500 ? "server timed out or crashed" : `non-JSON response (HTTP ${res.status})`)
              : (d.error || `HTTP ${res.status}`);
            for (const dom of batch) { counts.failed++; failures.push({ domain: dom, error: why }); }
          } else {
            for (const r of d.results || []) {
              if (r.status === "done") counts.done++;
              else if (r.status === "uploading") { counts.uploading++; uploading.push(r.domain); }
              else if (r.status === "skipped") { counts.skipped++; }
              else { counts.failed++; failures.push({ domain: r.domain, stage: r.stage, error: r.error || "failed" }); }
            }
          }
        } catch (e) {
          const why = e instanceof Error ? e.message : "network error";
          for (const dom of batch) { counts.failed++; failures.push({ domain: dom, error: why }); }
        }
        setMoveProgress({
          ...base,
          done: Math.min(i + BATCH, job.domains.length),
          counts: { ...counts },
          failures: [...failures],
          uploading: [...uploading],
          running: true,
          queued: false,
        });
      }
    } finally {
      // Never leave the panel stuck on "running".
      setMoveProgress((prev) => (prev ? { ...prev, running: false } : prev));
      setSelectedDomains(new Set());
      await Promise.all([loadDomains(), mutateDomainInstances()]);
    }
    });
  };

  const handleSync = async (slugs: BisonInstanceSlug[] = [...ALL_INSTANCE_SLUGS]) => {
    if (syncing) return;
    setSyncing(true);
    // Cursor pagination is sequential — one chain per instance. PAGES_PER_CHUNK
    // controls how many cursor pages the server walks per request before
    // returning a nextCursor for the FE to feed back in. We used to run 4
    // parallel offset streams per instance, but offset is hard-capped at 1000
    // pages × 15 = 15k senders and silently truncated big instances.
    // 80 pages per chunk with prefetch pipeline runs ~30s wall on the server,
    // safely under the 60s Vercel ceiling and roughly half the FE↔server
    // round trips vs the old 40. Tradeoff: fewer live progress updates.
    const PAGES_PER_CHUNK = 80;
    localStorage.removeItem("deliverability_next_page");
    setSavedPage(null);

    const initial: InstanceSyncProgress[] = slugs.map((slug) => ({
      slug,
      label: BISON_INSTANCES[slug].label,
      synced: 0,
      page: 0,
      lastPage: 0,
      status: "pending",
    }));
    setSyncProgresses(initial);

    const patchInstance = (slug: BisonInstanceSlug, patch: Partial<InstanceSyncProgress>) => {
      setSyncProgresses((prev) => prev?.map((p) => p.slug === slug ? { ...p, ...patch } : p) ?? null);
    };
    const incInstance = (slug: BisonInstanceSlug, syncedDelta: number, pagesDelta: number) => {
      const now = Date.now();
      setSyncProgresses((prev) => prev?.map((p) => p.slug === slug ? {
        ...p,
        synced: p.synced + syncedDelta,
        page: p.page + pagesDelta,
        lastUpdateAt: now,
      } : p) ?? null);
    };

    // Crawl one Bison instance end-to-end via cursor pagination + per-instance prune.
    const syncOneInstance = async (instance: BisonInstanceSlug): Promise<boolean> => {
      const nowStart = Date.now();
      patchInstance(instance, { status: "running", startedAt: nowStart, lastUpdateAt: nowStart });
      const syncStartedAt = new Date().toISOString();
      let anyChunkFailed = false;
      let cursor: string | null = null;

      try {
        console.log(`[SYNC:${instance}] Starting cursor walk, chunk=${PAGES_PER_CHUNK}`);
        while (true) {
          let success = false;
          let complete = false;
          let nextCursor: string | null = null;
          for (let attempt = 1; attempt <= 3; attempt++) {
            const t0 = performance.now();
            try {
              const res: Response = await fetch(`/api/deliverability/sync?instance=${instance}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ cursor, pagesPerChunk: PAGES_PER_CHUNK }),
              });
              if (!res.ok) {
                console.warn(`[SYNC:${instance}] chunk attempt ${attempt}: ${res.status}`);
                if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
                continue;
              }
              const result: {
                synced?: number;
                pagesWalked?: number;
                failedCursors?: string[];
                nextCursor?: string | null;
                complete?: boolean;
              } = await res.json();
              const ms = Math.round(performance.now() - t0);
              incInstance(instance, result.synced || 0, result.pagesWalked || 0);
              if (result.failedCursors?.length) anyChunkFailed = true;
              nextCursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
              complete = !!result.complete;
              console.log(`[SYNC:${instance}] chunk: ${result.synced} inboxes, ${result.pagesWalked} pages in ${ms}ms — ${complete ? "COMPLETE" : "resume"}`);
              success = true;
              break;
            } catch (e) {
              console.warn(`[SYNC:${instance}] chunk attempt ${attempt} error:`, e);
              if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
            }
          }
          if (!success) {
            anyChunkFailed = true;
            console.error(`[SYNC:${instance}] FAILED chunk after 3 attempts, stopping walk`);
            break;
          }
          if (complete) break;
          if (!nextCursor) {
            // Server said not complete but returned no cursor — bail safely
            // rather than looping forever.
            console.error(`[SYNC:${instance}] no nextCursor from server, stopping walk`);
            anyChunkFailed = true;
            break;
          }
          cursor = nextCursor;
        }

        if (!anyChunkFailed) {
          try {
            console.log(`[SYNC:${instance}] Pruning stale inboxes...`);
            const pruneRes = await fetch("/api/deliverability/prune", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ instance, before: syncStartedAt }),
            });
            const pruneData = await pruneRes.json();
            if (pruneData.skipped) {
              console.warn(`[SYNC:${instance}] Prune skipped: ${pruneData.reason}`);
            } else {
              console.log(`[SYNC:${instance}] Pruned ${pruneData.pruned} stale inboxes (of ${pruneData.total})`);
            }
          } catch (e) {
            console.error(`[SYNC:${instance}] Prune failed:`, e);
          }
        } else {
          console.log(`[SYNC:${instance}] Prune skipped — some chunks failed`);
        }

        patchInstance(instance, { status: anyChunkFailed ? "failed" : "done" });
        return !anyChunkFailed;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[SYNC:${instance}] Unhandled error:`, e);
        patchInstance(instance, { status: "failed", error: msg });
        return false;
      }
    };

    try {
      const syncStart = performance.now();
      // Run the selected Bison instances in parallel — each Bison has its own rate limit.
      await Promise.all(slugs.map((slug) => syncOneInstance(slug)));

      // Rebuild domain stats — single call covers all instances (SQL groups by instance,domain).
      console.log("[SYNC] Rebuilding domain stats...");
      const rebuildRes = await fetch("/api/deliverability/sync", { method: "PUT" });
      const rebuildData = await rebuildRes.json();
      console.log(`[SYNC] Domain rebuild: ${rebuildData.domains} domains from ${rebuildData.inboxes} inboxes`);

      const totalSec = ((performance.now() - syncStart) / 1000).toFixed(1);
      console.log(`[SYNC] COMPLETE in ${totalSec}s across ${slugs.length} instance(s)`);

      await loadDomains();
      await loadStats();
    } finally {
      setSyncing(false);
      setSyncProgresses(null);
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
  const isDomainAssigned = useCallback((d: DomainRow) => !isDomainReserve(d), [isDomainReserve]);
  const assignedCount = useMemo(() => domains.filter(isDomainAssigned).length, [domains, isDomainAssigned]);

  // Multi-client = domain has 2+ tags that match a known client_tag (from tracked_sheets)
  const isDomainMultiClient = useCallback((d: DomainRow) => {
    if (clientTags.size === 0 || !d.tags) return false;
    let count = 0;
    for (const t of d.tags) {
      if (clientTags.has(t)) {
        count++;
        if (count >= 2) return true;
      }
    }
    return false;
  }, [clientTags]);
  const multiClientCount = useMemo(() => domains.filter(isDomainMultiClient).length, [domains, isDomainMultiClient]);

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
          if (!d.tags) return false;
          return tagMatchMode === "AND"
            ? tagFilters.every((tag) => d.tags!.includes(tag))
            : tagFilters.some((tag) => d.tags!.includes(tag));
        }),
    [domains, warmupFilter, warmupSearch, showReserve, warmupTypeFilter, tagFilters, tagMatchMode, isDomainReserve, now]
  );

  // Flag computation helper — returns human-readable reason strings.
  // Logic lives in src/lib/inbox-health.ts so the MRL pace cron computes
  // per-client infrastructure health with the exact same rule.
  const getFlagReasons = useCallback((d: DomainRow): string[] => getDomainFlagReasons(d), []);

  const isDomainFlagged = useCallback((d: DomainRow) => getFlagReasons(d).length > 0, [getFlagReasons]);

  const hasReplyIssue = useCallback((d: DomainRow) => {
    return getFlagReasons(d).some((r) => r.startsWith("Low replies"));
  }, [getFlagReasons]);

  const hasBounceIssue = useCallback((d: DomainRow) => {
    return getFlagReasons(d).some((r) => r.startsWith("High bounces"));
  }, [getFlagReasons]);

  // Client-side filter: tag match (OR) + domain search + type filter + flagged
  // Export helpers — domain names only
  const exportDomainsCsv = useCallback((withStats?: boolean) => {
    const selected = domains.filter((d) => selectedDomains.has(d.domain));
    let csv: string;
    if (withStats) {
      const header = "Domain,Date Added,Inboxes,Sent,Replied,Bounced,Reply Rate 10d,Reply Rate 15d,Reply Rate 30d,Bounce Rate 10d,Bounce Rate 15d,Bounce Rate 30d,Daily Limit,Tags";
      const pct = (v: number | null | undefined) => (v != null ? `${v}%` : "");
      const rows = selected.map((d) => {
        let dateAdded = "";
        if (d.domain_created_at) {
          const dt = new Date(d.domain_created_at);
          const mm = String(dt.getMonth() + 1).padStart(2, "0");
          const dd = String(dt.getDate()).padStart(2, "0");
          dateAdded = `${mm}-${dd}-${dt.getFullYear()}`;
        }
        return `${d.domain},${dateAdded},${d.inbox_count},${d.total_sent || 0},${d.total_replied || 0},${d.total_bounced || 0},${pct(d.reply_10)},${pct(d.reply_15)},${pct(d.reply_30)},${pct(d.bounce_10)},${pct(d.bounce_15)},${pct(d.bounce_30)},${d.daily_limit_total || 0},"${(d.tags || []).join(", ")}"`;
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

  const startBulkLimitUpdate = useCallback(async (type: "daily" | "warmup", limit: number, domainList: string[]) => {
    setLimitJob({ type, limit, status: "running" });
    setSelectedDomains(new Set());
    try {
      const res = await fetch("/api/deliverability/bulk-limits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domains: domainList, type, limit }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setLimitJob({ type, limit, status: "done", updated: data.updated, total: data.total, error: data.failed > 0 ? `${data.failed} skipped (invalid)` : undefined });
      loadDomains();
    } catch (err) {
      setLimitJob({ type, limit, status: "error", error: err instanceof Error ? err.message : "Failed" });
    }
  }, [loadDomains]);

  // Sync selected domains — 4 parallel streams
  const startSyncSelected = useCallback(async (domainList: string[]) => {
    const STREAMS = 4;
    setSyncSelectedJob({ status: "running", synced: 0, totalDomains: domainList.length });
    setSelectedDomains(new Set());

    // Split domains into N chunks
    const chunkSize = Math.ceil(domainList.length / STREAMS);
    const chunks: string[][] = [];
    for (let i = 0; i < domainList.length; i += chunkSize) {
      chunks.push(domainList.slice(i, i + chunkSize));
    }

    let totalSynced = 0;
    let hasError = false;

    // Run streams in parallel
    const results = await Promise.allSettled(
      chunks.map(async (chunk) => {
        try {
          const res = await fetch("/api/deliverability/sync-domains", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ domains: chunk }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          totalSynced += data.synced || 0;
          setSyncSelectedJob((prev) => prev ? { ...prev, synced: totalSynced } : prev);
          return data;
        } catch (err) {
          hasError = true;
          throw err;
        }
      })
    );

    // Rebuild domain stats
    try {
      await fetch("/api/deliverability/sync", { method: "PUT" });
    } catch { /* best effort */ }

    const errors = results.filter((r) => r.status === "rejected");
    if (errors.length > 0 || hasError) {
      setSyncSelectedJob({ status: "error", synced: totalSynced, totalDomains: domainList.length, error: `${errors.length} stream(s) failed` });
    } else {
      setSyncSelectedJob({ status: "done", synced: totalSynced, totalDomains: domainList.length });
    }
    loadDomains();
  }, [loadDomains]);

  const startCheckRedirects = useCallback(async (domainList: string[]) => {
    if (domainList.length === 0) return;
    setRedirectCheckJob({ status: "running", checked: 0, total: domainList.length, redirects: 0 });
    setSelectedDomains(new Set());

    const CHUNK = 25;
    let checked = 0;
    let redirects = 0;
    let failedChunks = 0;
    for (let i = 0; i < domainList.length; i += CHUNK) {
      const slice = domainList.slice(i, i + CHUNK);
      try {
        const res = await fetch("/api/deliverability/check-redirects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domains: slice }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        const results: { redirectUrl: string | null }[] = data.results || [];
        checked += results.length;
        redirects += results.filter((r) => r.redirectUrl).length;
      } catch {
        // A chunk failing (timeout, network) shouldn't abort the whole run —
        // count it and keep going so the rest still get checked.
        failedChunks++;
        checked += slice.length;
      }
      setRedirectCheckJob({ status: "running", checked, total: domainList.length, redirects });
    }
    setRedirectCheckJob({
      status: failedChunks > 0 ? "error" : "done",
      checked,
      total: domainList.length,
      redirects,
      error: failedChunks > 0 ? `${failedChunks} batch${failedChunks !== 1 ? "es" : ""} failed — re-run to retry those` : undefined,
    });
    loadDomains();
  }, [loadDomains]);

  // Bulk Spamhaus DBL check. Same DNS-batched shape as SURBL.
  const startCheckSpamhaus = useCallback(async (domainList: string[]) => {
    if (domainList.length === 0) return;
    setSpamhausCheckJob({ status: "running", checked: 0, total: domainList.length, listed: 0, inconclusive: 0 });
    setSelectedDomains(new Set());

    const CHUNK = 500;
    let checked = 0;
    let listed = 0;
    let inconclusive = 0;
    let failedChunks = 0;
    let firstError: string | undefined;
    for (let i = 0; i < domainList.length; i += CHUNK) {
      const slice = domainList.slice(i, i + CHUNK);
      try {
        const res = await fetch("/api/deliverability/check-spamhaus", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domains: slice }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        checked += data.checked || 0;
        listed += data.listed || 0;
        inconclusive += data.inconclusive || 0;
      } catch (e) {
        failedChunks++;
        checked += slice.length;
        if (!firstError) firstError = e instanceof Error ? e.message : "Failed";
      }
      setSpamhausCheckJob({ status: "running", checked, total: domainList.length, listed, inconclusive });
    }
    setSpamhausCheckJob({
      status: failedChunks > 0 ? "error" : "done",
      checked,
      total: domainList.length,
      listed,
      inconclusive,
      error: failedChunks > 0
        ? firstError || `${failedChunks} batch${failedChunks !== 1 ? "es" : ""} failed`
        : undefined,
    });
    loadDomains();
  }, [loadDomains]);

  // Bulk SURBL blacklist check. DNS is fast — push bigger chunks than redirects.
  const startCheckBlacklist = useCallback(async (domainList: string[]) => {
    if (domainList.length === 0) return;
    setBlacklistCheckJob({ status: "running", checked: 0, total: domainList.length, listed: 0, inconclusive: 0 });
    setSelectedDomains(new Set());

    const CHUNK = 500;
    let checked = 0;
    let listed = 0;
    let inconclusive = 0;
    let failedChunks = 0;
    for (let i = 0; i < domainList.length; i += CHUNK) {
      const slice = domainList.slice(i, i + CHUNK);
      try {
        const res = await fetch("/api/deliverability/check-blacklist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domains: slice }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        checked += data.checked || 0;
        listed += data.listed || 0;
        inconclusive += data.inconclusive || 0;
      } catch {
        failedChunks++;
        checked += slice.length;
      }
      setBlacklistCheckJob({ status: "running", checked, total: domainList.length, listed, inconclusive });
    }
    setBlacklistCheckJob({
      status: failedChunks > 0 ? "error" : "done",
      checked,
      total: domainList.length,
      listed,
      inconclusive,
      error: failedChunks > 0 ? `${failedChunks} batch${failedChunks !== 1 ? "es" : ""} failed — re-run to retry those` : undefined,
    });
    loadDomains();
  }, [loadDomains]);

  // Drag-to-select: track by index range so fast scrolling doesn't skip rows
  const dragStartIdx = useRef(-1);
  const dragLastIdx = useRef(-1);

  const handleDragStart = useCallback((idx: number, domain: string) => {
    isDragging.current = true;
    dragStartIdx.current = idx;
    dragLastIdx.current = idx;
    const wasSelected = selectedDomains.has(domain);
    dragSelectMode.current = !wasSelected;
    setSelectedDomains((prev) => {
      const next = new Set(prev);
      if (dragSelectMode.current) next.add(domain);
      else next.delete(domain);
      return next;
    });
  }, [selectedDomains]);

  const handleDragEnter = useCallback((idx: number, filteredList: { domain: string }[]) => {
    if (!isDragging.current || idx === dragLastIdx.current) return;
    // Select/deselect all rows between last index and current index (fills gaps from fast scrolling)
    const from = Math.min(dragLastIdx.current, idx);
    const to = Math.max(dragLastIdx.current, idx);
    dragLastIdx.current = idx;
    setSelectedDomains((prev) => {
      const next = new Set(prev);
      for (let i = from; i <= to; i++) {
        const d = filteredList[i]?.domain;
        if (!d) continue;
        if (dragSelectMode.current) next.add(d);
        else next.delete(d);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const handleMouseUp = () => { isDragging.current = false; dragStartIdx.current = -1; };
    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, []);

  const filteredDomains = useMemo(() => {
    let result = domains;
    if (tagFilters.length > 0) {
      result = result.filter((d) => {
        if (!d.tags) return false;
        return tagMatchMode === "AND"
          ? tagFilters.every((tag) => d.tags!.includes(tag))
          : tagFilters.some((tag) => d.tags!.includes(tag));
      });
    }
    if (domainSearch.trim()) {
      // Comma-separated: matches a domain if it contains ANY of the terms.
      const terms = domainSearch
        .toLowerCase()
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      if (terms.length > 0) {
        result = result.filter((d) => {
          const dom = d.domain.toLowerCase();
          return terms.some((t) => dom.includes(t));
        });
      }
    }
    if (redirectSearch.trim()) {
      const q = redirectSearch.toLowerCase().trim();
      result = result.filter((d) => (d.redirect_url || "").toLowerCase().includes(q));
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
    if (showHealthy) {
      result = result.filter((d) => !isDomainFlagged(d));
    }
    if (showBlacklisted) {
      result = result.filter((d) => d.blacklisted === true);
    }
    if (showNotBlacklisted) {
      result = result.filter((d) => d.blacklisted === false);
    }
    if (showSpamhausListed) {
      result = result.filter((d) => d.spamhaus_dbl === true);
    }
    if (showSpamhausClean) {
      result = result.filter((d) => d.spamhaus_dbl === false);
    }
    if (showReserve) {
      result = result.filter(isDomainReserve);
    }
    if (showAssigned) {
      result = result.filter(isDomainAssigned);
    }
    // Provider lifecycle filter. Rows without an entry in providerStatusMap
    // are treated as "unknown" (missing Inboxing/Milkbox tag, or the daily
    // cron hasn't reached them yet).
    if (providerStatusFilter !== "all") {
      result = result.filter((d) => {
        const entry = providerStatusMap[`${d.instance}:${d.domain}`];
        if (providerStatusFilter === "unknown") return !entry;
        if (!entry) return false;
        return entry.status === providerStatusFilter;
      });
    }
    if (showMultiClient) {
      result = result.filter(isDomainMultiClient);
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
    // Warmup range filter (from-to)
    if (warmupDaysFrom || warmupDaysTo) {
      const from = warmupDaysFrom ? parseInt(warmupDaysFrom) : 0;
      const to = warmupDaysTo ? parseInt(warmupDaysTo) : 21;
      result = result.filter((d) => {
        const daysOld = d.domain_created_at
          ? Math.floor((now - new Date(d.domain_created_at).getTime()) / (1000 * 60 * 60 * 24))
          : 0;
        const daysLeft = Math.max(0, 21 - daysOld);
        return daysLeft >= from && daysLeft <= to;
      });
    }
    // Multi-condition filter (AND = every / OR = some)
    const activeConditions = filterConditions.filter((c) => c.value.trim() !== "");
    if (activeConditions.length > 0) {
      const ctx: FilterCtx = { providerStatusMap, domainInstancesMap };
      result = result.filter((d) =>
        filterMatchMode === "all"
          ? activeConditions.every((c) => evalCondition(d, c, ctx))
          : activeConditions.some((c) => evalCondition(d, c, ctx))
      );
    }
    // Sort
    if (sortField) {
      const dir = sortDir === "asc" ? 1 : -1;
      result = [...result].sort((a, b) => {
        let av: number | string = 0, bv: number | string = 0;
        switch (sortField) {
          case "domain": av = a.domain; bv = b.domain; return dir * av.localeCompare(bv);
          case "blacklisted":
            // never-checked < clean < listed
            av = a.blacklisted == null ? -1 : a.blacklisted ? 1 : 0;
            bv = b.blacklisted == null ? -1 : b.blacklisted ? 1 : 0;
            break;
          case "spamhaus_dbl":
            av = a.spamhaus_dbl == null ? -1 : a.spamhaus_dbl ? 1 : 0;
            bv = b.spamhaus_dbl == null ? -1 : b.spamhaus_dbl ? 1 : 0;
            break;
          case "redirect_url":
            av = (a.redirect_url || "").toLowerCase();
            bv = (b.redirect_url || "").toLowerCase();
            return dir * av.localeCompare(bv);
          case "inbox_count": av = a.inbox_count; bv = b.inbox_count; break;
          case "total_sent": av = a.total_sent || 0; bv = b.total_sent || 0; break;
          case "total_replied": av = a.total_replied || 0; bv = b.total_replied || 0; break;
          case "reply_rate":
            av = (a.total_replied || 0) / (a.total_sent || 1);
            bv = (b.total_replied || 0) / (b.total_sent || 1);
            break;
          case "reply_trailing": av = a.reply_10 ?? -1; bv = b.reply_10 ?? -1; break;
          case "total_bounced": av = a.total_bounced || 0; bv = b.total_bounced || 0; break;
          case "bounce_rate":
            av = (a.total_bounced || 0) / (a.total_sent || 1);
            bv = (b.total_bounced || 0) / (b.total_sent || 1);
            break;
          case "bounce_trailing": av = a.bounce_10 ?? -1; bv = b.bounce_10 ?? -1; break;
          case "daily_limit": av = a.daily_limit_total || 0; bv = b.daily_limit_total || 0; break;
          case "warmup_days": {
            const aDays = a.domain_created_at ? Math.max(0, 21 - Math.floor((now - new Date(a.domain_created_at).getTime()) / 86400000)) : 0;
            const bDays = b.domain_created_at ? Math.max(0, 21 - Math.floor((now - new Date(b.domain_created_at).getTime()) / 86400000)) : 0;
            av = aDays; bv = bDays; break;
          }
          case "instances":
            av = (domainInstancesMap[a.domain] ?? [a.instance]).length;
            bv = (domainInstancesMap[b.domain] ?? [b.instance]).length;
            break;
        }
        return dir * ((av as number) - (bv as number));
      });
    }
    return result;
  }, [domains, tagFilters, tagMatchMode, domainSearch, redirectSearch, typeFilter, showFlagged, flagSubFilter, showHealthy, showBlacklisted, showNotBlacklisted, showSpamhausListed, showSpamhausClean, showReserve, showAssigned, showMultiClient, providerStatusFilter, providerStatusMap, domainInstancesMap, warmupDaysFilter, warmupDaysFrom, warmupDaysTo, filterConditions, filterMatchMode, sortField, sortDir, isDomainFlagged, hasReplyIssue, hasBounceIssue, isDomainReserve, isDomainAssigned, isDomainMultiClient, now]);

  const flaggedCount = useMemo(() => domains.filter(isDomainFlagged).length, [domains, isDomainFlagged]);
  const healthyCount = useMemo(() => domains.filter((d) => !isDomainFlagged(d)).length, [domains, isDomainFlagged]);
  const blacklistedCount = useMemo(() => domains.filter((d) => d.blacklisted === true).length, [domains]);
  const notBlacklistedCount = useMemo(() => domains.filter((d) => d.blacklisted === false).length, [domains]);
  const spamhausListedCount = useMemo(() => domains.filter((d) => d.spamhaus_dbl === true).length, [domains]);
  const spamhausCleanCount = useMemo(() => domains.filter((d) => d.spamhaus_dbl === false).length, [domains]);

  // --- Column show/hide persistence + derived visible columns / grid template ---
  useEffect(() => {
    try {
      const raw = localStorage.getItem("deliverabilityColumns");
      if (raw) setColumnVisibility(JSON.parse(raw));
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem("deliverabilityColumns", JSON.stringify(columnVisibility)); } catch { /* ignore */ }
  }, [columnVisibility]);
  const isColVisible = useCallback((field: string) => columnVisibility[field] !== false, [columnVisibility]);
  const visibleColumns = useMemo(
    () => TABLE_COLUMNS.filter((c) => !c.toggleable || columnVisibility[c.field] !== false),
    [columnVisibility],
  );
  const gridTemplateColumns = useMemo(
    () => `28px ${visibleColumns.map((c) => c.width).join(" ")}`,
    [visibleColumns],
  );

  // Tag filter options — union of (a) every tag defined in the selected Bison
  // instances and (b) tags on the currently-loaded domains as a fallback. This
  // shows tags even when no loaded domain currently carries them.
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const t of bisonTags) {
      if (t) set.add(t);
    }
    for (const d of domains) {
      for (const t of d.tags || []) {
        if (t) set.add(t);
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [bisonTags, domains]);

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
  // Derive inbox count from loaded domains (the sync-stats count endpoint can lag/return 0 on large tables).
  const totalInboxesFromDomains = useMemo(
    () => domains.reduce((sum, d) => sum + (d.inbox_count || 0), 0),
    [domains]
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Deliverability"
        description={(() => {
          const inboxCount = totalInboxesFromDomains > 0 ? totalInboxesFromDomains : (syncStats?.inboxCount ?? 0);
          const domainCount = domains.length || syncStats?.domainCount || 0;
          if (!syncStats && domains.length === 0) return "Manage your sender inboxes and email warmup";
          return `${inboxCount.toLocaleString()} inboxes across ${domainCount.toLocaleString()} domains`;
        })()}
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
          {isAdmin && (
            <>
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
                onClick={() => setConformTagsOpen(true)}
                className="gap-2"
                title="Push each domain's tags down to every sender on that domain"
              >
                <Tags className="h-4 w-4" />
                Conform Tags
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleProviderCheck}
                disabled={providerChecking}
                className="gap-2"
                title="Pull live active/canceled status from Inboxing, MilkBox + ScaledMail for every tagged domain (also runs automatically every 24h)"
              >
                {providerChecking ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                {providerChecking ? "Checking…" : "Check Provider Status"}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={syncing}
                    className="gap-2"
                  >
                    <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
                    {syncing ? "Syncing…" : "Sync Inboxes"}
                    <ChevronDown className="h-3.5 w-3.5 opacity-70" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>Sync which instance?</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => handleSync([...ALL_INSTANCE_SLUGS])}>
                    All {ALL_INSTANCE_SLUGS.length} instances
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {ALL_INSTANCE_SLUGS.map((slug) => (
                    <DropdownMenuItem key={slug} onClick={() => handleSync([slug])}>
                      {BISON_INSTANCES[slug].label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </div>
      </PageHeader>

      {/* Provider status check — one row per provider, all 3 in parallel */}
      {providerCheckRows && (
        <div className="rounded-lg border bg-muted/30 px-4 py-3 space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Checking provider domain status (active / canceled at the provider)</span>
            {!providerChecking && (
              <button onClick={() => setProviderCheckRows(null)} className="shrink-0 opacity-60 hover:opacity-100" title="Dismiss">✕</button>
            )}
          </div>
          {providerCheckRows.map((r) => (
            <div key={r.provider} className="flex items-center gap-3 text-xs">
              <span className="w-24 shrink-0 font-medium">{r.label}</span>
              {r.state === "running" && (
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> checking…
                </span>
              )}
              {r.state === "done" && (
                <span className="text-muted-foreground">
                  <span className="text-foreground">{(r.scanned ?? 0).toLocaleString()}</span> domains checked
                  {" · "}
                  <span className={r.canceled ? "text-amber-500" : ""}>{r.canceled ?? 0} canceled</span>
                  {r.failed ? <span className="text-destructive"> · {r.failed} failed</span> : null}
                  <CheckCircle2 className="ml-1.5 inline h-3 w-3 text-emerald-500" />
                </span>
              )}
              {r.state === "error" && <span className="text-destructive truncate">{r.error}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Move-to-instance progress — batched Inboxing platform-upload moves */}
      {moveProgress && (
        <div className="rounded-lg border bg-muted/30 px-4 py-3 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-2">
              {moveProgress.queued
                ? <Clock className="h-3.5 w-3.5 text-amber-500" />
                : moveProgress.running
                ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
              <span className="font-medium">
                {moveProgress.queued
                  ? `Queued — waiting for the previous process… (${moveProgress.total} domains → ${moveProgress.targetLabel})`
                  : `${moveProgress.running ? "Moving" : "Move finished —"} ${moveProgress.done}/${moveProgress.total} domains → ${moveProgress.targetLabel}`}
              </span>
              <span className="text-muted-foreground">via Inboxing “{moveProgress.connectionName}”</span>
            </span>
            {!moveProgress.running && (
              <button
                onClick={() => {
                  dismissedRunsRef.current.add(moveProgress.id); // cancels if still queued
                  setMoveProgress(null);
                }}
                className="shrink-0 opacity-60 hover:opacity-100"
                title={moveProgress.queued ? "Cancel" : "Dismiss"}
              >✕</button>
            )}
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${moveProgress.total ? (moveProgress.done / moveProgress.total) * 100 : 0}%` }} />
          </div>
          <div className="text-[11px] text-muted-foreground">
            <span className={moveProgress.counts.done ? "text-emerald-500" : ""}>{moveProgress.counts.done} moved</span>
            {" · "}
            <span className={moveProgress.counts.uploading ? "text-amber-500" : ""}>{moveProgress.counts.uploading} still uploading</span>
            {" · "}
            <span>{moveProgress.counts.skipped} skipped</span>
            {" · "}
            <span className={moveProgress.counts.failed ? "text-destructive" : ""}>{moveProgress.counts.failed} failed</span>
          </div>
          {moveProgress.uploading.length > 0 && (
            <div className="rounded-md border border-amber-500/30 bg-amber-950/10 px-3 py-1.5 text-[11px] text-amber-400">
              Still uploading at Inboxing (nothing deleted from the source — re-run Move for these later to finish):{" "}
              <span className="text-amber-300">{moveProgress.uploading.join(", ")}</span>
            </div>
          )}
          {moveProgress.failures.length > 0 && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5">
              <div className="px-3 py-1.5 text-[11px] text-destructive font-medium">
                {moveProgress.failures.length} domain{moveProgress.failures.length === 1 ? "" : "s"} failed — they stay in place, re-run Move to retry
              </div>
              <div className="max-h-32 overflow-y-auto divide-y divide-destructive/10 border-t border-destructive/20">
                {moveProgress.failures.slice(0, 30).map((f, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-1 text-[11px]">
                    <span className="font-medium shrink-0">{f.domain}</span>
                    {f.stage && <span className="text-muted-foreground shrink-0">[{f.stage}]</span>}
                    <span className="text-destructive/80 truncate">{f.error}</span>
                  </div>
                ))}
                {moveProgress.failures.length > 30 && (
                  <div className="px-3 py-1 text-[11px] text-muted-foreground">…and {moveProgress.failures.length - 30} more</div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Sync Progress — one row per Bison instance, all 4 in parallel */}
      {syncProgresses && (
        <div className="rounded-lg border bg-muted/30 px-4 py-3 space-y-2">
          <div className="text-xs text-muted-foreground">
            {syncProgresses.length === 1
              ? `Syncing ${syncProgresses[0].label}`
              : `Syncing ${syncProgresses.length} Bison instances in parallel`}
          </div>
          {syncProgresses.map((p) => {
            const pct = p.lastPage > 0 ? Math.min(100, (p.page / p.lastPage) * 100) : 0;
            // Live throughput + freshness (only when running). Rate is
            // inboxes/s over the whole run so far; secsSinceUpdate is what
            // makes "is it stuck?" answerable at a glance.
            const runningSecs = p.startedAt ? Math.max(0, (nowTick - p.startedAt) / 1000) : 0;
            const rate = p.status === "running" && runningSecs > 2 ? p.synced / runningSecs : 0;
            const secsSinceUpdate = p.lastUpdateAt ? Math.floor((nowTick - p.lastUpdateAt) / 1000) : 0;
            const freshTone =
              p.status !== "running"
                ? "text-muted-foreground"
                : secsSinceUpdate < 15
                  ? "text-emerald-400"
                  : secsSinceUpdate < 60
                    ? "text-amber-400"
                    : "text-red-400";
            return (
              <div key={p.slug} className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2 min-w-0">
                    {p.status === "running" && <RefreshCw className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />}
                    {p.status === "done" && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />}
                    {p.status === "failed" && <AlertTriangle className="h-3.5 w-3.5 text-red-500 shrink-0" />}
                    {p.status === "pending" && <Clock className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />}
                    <span className={`truncate ${p.status === "pending" ? "text-muted-foreground" : ""}`}>
                      {p.label}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {p.synced.toLocaleString()} inboxes
                    </span>
                    {p.status === "running" && rate > 0 && (
                      <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                        · {rate.toFixed(0)}/s
                      </span>
                    )}
                    {p.status === "running" && p.lastUpdateAt && (
                      <span className={`text-xs shrink-0 tabular-nums ${freshTone}`}>
                        · updated {secsSinceUpdate}s ago
                      </span>
                    )}
                    {p.status === "done" && p.startedAt && (
                      <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                        · walked in {Math.round(runningSecs)}s
                      </span>
                    )}
                  </div>
                  {p.lastPage > 0 ? (
                    <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                      {p.page.toLocaleString()}/{p.lastPage.toLocaleString()} pages ({Math.round(pct)}%)
                    </span>
                  ) : p.status === "running" || p.status === "done" ? (
                    // Cursor pagination doesn't tell us the total upfront — show
                    // the running page count so the user sees progress.
                    <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                      {p.page.toLocaleString()} pages walked
                    </span>
                  ) : null}
                </div>
                <div className={`h-1 rounded-full bg-muted overflow-hidden ${p.status === "running" ? "animate-pulse" : ""}`}>
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      p.status === "done"
                        ? "bg-emerald-500"
                        : p.status === "failed"
                          ? "bg-red-500"
                          : "bg-primary"
                    }`}
                    // When cursor mode leaves us without a percentage, show a
                    // steady half-full bar with the pulse animation above so
                    // the user knows the sync is *alive*, not stuck at 0%.
                    style={{
                      width: `${
                        p.status === "done"
                          ? 100
                          : p.lastPage > 0
                            ? pct
                            : p.status === "running"
                              ? 50
                              : 0
                      }%`,
                    }}
                  />
                </div>
                {p.error && (
                  <p className="text-xs text-red-400">{p.error}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Background Attach Progress */}
      {/* Attach-to-campaigns runs — one stacked panel per run, newest at the
          bottom, each dismissed only manually and never replaced by a new run */}
      {attachRuns.map((run) => {
        const totalRetryable = run.jobs.reduce((s, j) => s + (j.rateLimited ?? 0), 0);
        return (
        <div key={run.id} className="rounded-lg border bg-muted/30 px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-sm">
              {run.queued ? <Clock className="h-3.5 w-3.5 text-amber-500" />
                : run.running ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> : null}
              <span className="font-medium">
                {run.queued ? "Queued — waiting for the previous process…"
                  : run.running ? "Attaching to campaigns..." : "Attachment complete"}
              </span>
              <span className="text-xs text-muted-foreground">
                {run.jobs.filter((j) => j.status === "done").length}/{run.jobs.length} campaigns · {run.domains.length} domains
              </span>
            </div>
            <div className="flex items-center gap-3">
              {!run.running && !run.queued && totalRetryable > 0 && (
                <button
                  onClick={() => retrySkippedAttach(run)}
                  className="flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <RefreshCw className="h-3 w-3" /> Retry {totalRetryable} skipped (rate-limited)
                </button>
              )}
              {!run.running && (
                <button
                  onClick={() => {
                    dismissedRunsRef.current.add(run.id); // cancels it if still queued
                    setAttachRuns((prev) => prev.filter((r) => r.id !== run.id));
                  }}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  {run.queued ? "Cancel" : "Dismiss"}
                </button>
              )}
            </div>
          </div>
          <div className="space-y-1 max-h-60 overflow-y-auto">
            {run.jobs.map((job, i) => (
              <div key={i}>
                <div className="flex items-center gap-2 text-xs">
                  {job.status === "running" && <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />}
                  {job.status === "done" && (job.failed ?? 0) === 0 && <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />}
                  {job.status === "done" && (job.failed ?? 0) > 0 && <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />}
                  {job.status === "error" && <AlertTriangle className="h-3 w-3 text-destructive shrink-0" />}
                  {job.status === "pending" && <div className="h-3 w-3 rounded-full border border-muted-foreground/30 shrink-0" />}
                  <span className="truncate text-muted-foreground">{job.campaign}</span>
                  {job.status === "done" && (
                    <span className="shrink-0 ml-auto text-emerald-500">
                      +{job.newly} · {job.existing} existing
                      {(job.failed ?? 0) > 0 && (
                        <button
                          onClick={() => setShowSkippedAttach((v) => (v === `${run.id}:${i}` ? null : `${run.id}:${i}`))}
                          className="text-amber-500 hover:underline"
                        >
                          {" "}({job.failed} skipped{(job.rateLimited ?? 0) > 0 ? `, ${job.rateLimited} retryable` : ""} — {showSkippedAttach === `${run.id}:${i}` ? "hide" : "why?"})
                        </button>
                      )}
                    </span>
                  )}
                  {job.status === "error" && (
                    <span className="shrink-0 ml-auto text-destructive">{job.error}</span>
                  )}
                </div>
                {/* Per-campaign skip reasons — explains WHY each inbox was skipped */}
                {showSkippedAttach === `${run.id}:${i}` && (job.failedInboxes?.length ?? 0) > 0 && (
                  <div className="mt-1 mb-2 ml-5 rounded-lg border border-amber-500/30 bg-amber-500/5 max-h-48 overflow-y-auto divide-y divide-amber-500/10">
                    {job.failedInboxes!.map((f, k) => (
                      <div key={`${f.email}-${k}`} className="px-3 py-1.5 flex items-center justify-between gap-2">
                        <span className="text-[11px] font-mono text-foreground/80 truncate">{f.email}</span>
                        <span className={`text-[10px] shrink-0 ${f.retryable ? "text-primary" : "text-amber-500"}`}>{f.reason}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
        );
      })}

      {/* Background Tag + Campaign + Sheet runs — stacked, manual dismiss only */}
      {tagCampaignRuns.map((run) => {
        const sheetDone = !run.sheetStatus || run.sheetStatus === "done" || run.sheetStatus === "error" || run.sheetStatus === "skipped";
        const allDone = run.tagStatus !== "running" && run.campaignsDone && sheetDone;
        const hasError = run.tagStatus === "error"
          || run.campaignJobs.some((j) => j.status === "error")
          || run.sheetStatus === "error";
        const retryNow = () => retryTagCampaignRun(run.id, run.info);
        const dismiss = () => {
          tagRetryTokensRef.current.set(run.id, (tagRetryTokensRef.current.get(run.id) ?? 0) + 1);
          dismissedRunsRef.current.add(run.id); // cancels it if still queued
          setTagCampaignRuns((prev) => prev.filter((r) => r.id !== run.id));
        };
        return (
        <div key={run.id} className="rounded-lg border bg-muted/30 px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-sm">
              {run.queued ? <Clock className="h-3.5 w-3.5 text-amber-500" />
                : run.retry ? <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" />
                : !allDone ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                : hasError ? <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
              <span className="font-medium">
                {run.queued ? "Queued — waiting for the previous process…"
                  : run.retry
                  ? (run.retry.countdown > 0
                      ? `Retrying in ${run.retry.countdown}s (attempt ${run.retry.attempt} of ${run.retry.total})`
                      : `Retrying… (attempt ${run.retry.attempt} of ${run.retry.total})`)
                  : !allDone ? "Processing..."
                  : hasError ? "Completed with errors"
                  : "Complete"}
              </span>
              <span className="text-xs text-muted-foreground">{run.domains.length} domains</span>
            </div>
            {run.queued && (
              <button onClick={dismiss} className="text-xs text-muted-foreground hover:text-foreground">Cancel</button>
            )}
            {!run.queued && (allDone || run.retry) && (
              <div className="flex items-center gap-3">
                {run.retry ? (
                  <button onClick={retryNow} className="text-xs text-primary hover:underline">Retry now</button>
                ) : hasError ? (
                  <button onClick={retryNow} className="text-xs font-medium text-primary hover:underline">Retry</button>
                ) : null}
                {allDone && !run.retry && (
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(run.domains.join("\n"));
                      setDomainsCopied(run.id);
                      setTimeout(() => setDomainsCopied(null), 2000);
                    }}
                    className="text-xs text-primary hover:underline"
                  >
                    {domainsCopied === run.id ? "Copied!" : "Copy Domains"}
                  </button>
                )}
                <button onClick={dismiss} className="text-xs text-muted-foreground hover:text-foreground">Dismiss</button>
              </div>
            )}
          </div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {/* Tag status line */}
            <div className="flex items-center gap-2 text-xs">
              {run.tagStatus === "running" && <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />}
              {run.tagStatus === "done" && (run.tagFailed ?? 0) > 0 && <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />}
              {run.tagStatus === "done" && (run.tagFailed ?? 0) === 0 && <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />}
              {run.tagStatus === "error" && <AlertTriangle className="h-3 w-3 text-destructive shrink-0" />}
              <span className="text-muted-foreground">{run.tagLabel}</span>
              {run.tagStatus === "done" && (
                <span className="shrink-0 ml-auto text-emerald-500">
                  {run.tagAffected} inboxes
                  {(run.tagFailed ?? 0) > 0 && (
                    <button
                      onClick={() => setShowSkippedList((v) => (v === run.id ? null : run.id))}
                      className="text-amber-500 hover:underline"
                    >
                      {" "}({run.tagFailed} skipped — {showSkippedList === run.id ? "hide" : "view"})
                    </button>
                  )}
                </span>
              )}
              {run.tagStatus === "error" && <span className="shrink-0 ml-auto text-destructive">{run.tagError}</span>}
            </div>
            {/* Campaign lines */}
            {run.campaignJobs.map((job, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                {job.status === "running" && <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />}
                {job.status === "done" && <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />}
                {job.status === "error" && <AlertTriangle className="h-3 w-3 text-destructive shrink-0" />}
                {job.status === "pending" && <div className="h-3 w-3 rounded-full border border-muted-foreground/30 shrink-0" />}
                <span className="truncate text-muted-foreground">{job.campaign}</span>
                {job.status === "done" && <span className="shrink-0 ml-auto text-emerald-500">+{job.newly} · {job.existing} existing{(job.failed ?? 0) > 0 && <span className="text-amber-500"> ({job.failed} skipped)</span>}</span>}
                {job.status === "error" && <span className="shrink-0 ml-auto text-destructive">{job.error}</span>}
              </div>
            ))}
            {/* Sheet append line */}
            {run.sheetStatus && run.sheetStatus !== "skipped" && (
              <div className="flex items-center gap-2 text-xs">
                {run.sheetStatus === "running" && <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />}
                {run.sheetStatus === "done" && <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />}
                {run.sheetStatus === "error" && <AlertTriangle className="h-3 w-3 text-destructive shrink-0" />}
                <span className="text-muted-foreground">{run.sheetLabel}</span>
                {run.sheetStatus === "done" && (
                  <span className="shrink-0 ml-auto text-emerald-500">
                    +{run.sheetAdded} added
                    {(run.sheetDuplicates ?? 0) > 0 && (
                      <span className="text-amber-500"> ({run.sheetDuplicates} duplicates)</span>
                    )}
                  </span>
                )}
                {run.sheetStatus === "error" && <span className="shrink-0 ml-auto text-destructive">{run.sheetError}</span>}
              </div>
            )}
          </div>

          {/* Skipped inboxes detail — disconnected / no-longer-existing accounts */}
          {showSkippedList === run.id && (run.tagFailedInboxes?.length ?? 0) > 0 && (
            <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5">
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-amber-500/20">
                <span className="text-[11px] font-medium text-amber-500">
                  {run.tagFailedInboxes!.length} inboxes skipped — likely disconnected or no longer in the email tool
                </span>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(
                      run.tagFailedInboxes!.map((f) => f.email).join("\n")
                    );
                    setSkippedCopied(run.id);
                    setTimeout(() => setSkippedCopied(null), 2000);
                  }}
                  className="text-[11px] text-primary hover:underline shrink-0 ml-2"
                >
                  {skippedCopied === run.id ? "Copied!" : "Copy emails"}
                </button>
              </div>
              <div className="max-h-56 overflow-y-auto divide-y divide-amber-500/10">
                {run.tagFailedInboxes!.map((f, i) => (
                  <div key={`${f.email}-${i}`} className="px-3 py-1.5">
                    <div className="text-[11px] font-mono text-foreground/80 truncate">{f.email}</div>
                    <div className="text-[10px] text-muted-foreground/70 truncate">{f.domain} · {f.reason}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        );
      })}

      {/* Standalone Sheet Append (Whitelist) runs — stacked, manual dismiss */}
      {sheetAppendJobs.map((job) => (
        <div key={job.id} className="rounded-lg border bg-muted/30 px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              {job.status === "running" && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
              {job.status === "done" && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
              {job.status === "error" && <AlertTriangle className="h-3.5 w-3.5 text-destructive" />}
              <span className="font-medium">{job.label}</span>
              {job.status === "done" && (
                <span className="text-xs text-emerald-500 ml-2">
                  +{job.added} added
                  {(job.duplicates ?? 0) > 0 && (
                    <span className="text-amber-500"> ({job.duplicates} duplicates)</span>
                  )}
                  {job.whitelist && (
                    <span className="text-muted-foreground"> · {job.whitelist}</span>
                  )}
                </span>
              )}
              {job.status === "error" && (
                <span className="text-xs text-destructive ml-2">{job.error}</span>
              )}
            </div>
            {job.status !== "running" && (
              <button onClick={() => setSheetAppendJobs((prev) => prev.filter((j) => j.id !== job.id))} className="text-xs text-muted-foreground hover:text-foreground">Dismiss</button>
            )}
          </div>
        </div>
      ))}

      {/* Bulk Limit Update Progress */}
      {limitJob && (
        <div className="rounded-lg border bg-muted/30 px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              {limitJob.status === "running" && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
              {limitJob.status === "done" && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
              {limitJob.status === "error" && <AlertTriangle className="h-3.5 w-3.5 text-destructive" />}
              <span className="font-medium">
                {limitJob.status === "running"
                  ? `Updating ${limitJob.type === "daily" ? "daily sending" : "warmup"} limit to ${limitJob.limit}...`
                  : limitJob.status === "done"
                    ? `${limitJob.type === "daily" ? "Daily sending" : "Warmup"} limit updated to ${limitJob.limit}`
                    : "Limit update failed"}
              </span>
              {limitJob.status === "done" && (
                <span className="text-xs text-muted-foreground">
                  {limitJob.updated}/{limitJob.total} inboxes
                  {limitJob.error && <span className="text-amber-500 ml-2">· {limitJob.error}</span>}
                </span>
              )}
              {limitJob.status === "error" && (
                <span className="text-xs text-destructive">{limitJob.error}</span>
              )}
            </div>
            {limitJob.status !== "running" && (
              <button onClick={() => setLimitJob(null)} className="text-xs text-muted-foreground hover:text-foreground">Dismiss</button>
            )}
          </div>
        </div>
      )}

      {/* Check Spamhaus Progress */}
      {spamhausCheckJob && (
        <div className="rounded-lg border bg-muted/30 px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              {spamhausCheckJob.status === "running" && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
              {spamhausCheckJob.status === "done" && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
              {spamhausCheckJob.status === "error" && <AlertTriangle className="h-3.5 w-3.5 text-destructive" />}
              <span className="font-medium">
                {spamhausCheckJob.status === "running"
                  ? `Checking Spamhaus DBL · ${spamhausCheckJob.checked} / ${spamhausCheckJob.total}`
                  : spamhausCheckJob.status === "done"
                    ? `Spamhaus: checked ${spamhausCheckJob.total} domain${spamhausCheckJob.total !== 1 ? "s" : ""}`
                    : "Spamhaus check failed"}
              </span>
              <span className="text-xs text-destructive">{spamhausCheckJob.listed} listed</span>
              {spamhausCheckJob.inconclusive > 0 && (
                <span className="text-xs text-amber-500">· {spamhausCheckJob.inconclusive} inconclusive</span>
              )}
              {spamhausCheckJob.status === "error" && spamhausCheckJob.error && (
                <span className="text-xs text-destructive">· {spamhausCheckJob.error}</span>
              )}
            </div>
            {spamhausCheckJob.status !== "running" && (
              <button onClick={() => setSpamhausCheckJob(null)} className="text-xs text-muted-foreground hover:text-foreground">Dismiss</button>
            )}
          </div>
        </div>
      )}

      {/* Check Blacklist Progress */}
      {blacklistCheckJob && (
        <div className="rounded-lg border bg-muted/30 px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              {blacklistCheckJob.status === "running" && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
              {blacklistCheckJob.status === "done" && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
              {blacklistCheckJob.status === "error" && <AlertTriangle className="h-3.5 w-3.5 text-destructive" />}
              <span className="font-medium">
                {blacklistCheckJob.status === "running"
                  ? `Checking blacklist · ${blacklistCheckJob.checked} / ${blacklistCheckJob.total}`
                  : blacklistCheckJob.status === "done"
                    ? `Checked ${blacklistCheckJob.total} domain${blacklistCheckJob.total !== 1 ? "s" : ""}`
                    : "Blacklist check failed"}
              </span>
              <span className="text-xs text-destructive">{blacklistCheckJob.listed} listed</span>
              {blacklistCheckJob.inconclusive > 0 && (
                <span className="text-xs text-amber-500">· {blacklistCheckJob.inconclusive} inconclusive</span>
              )}
              {blacklistCheckJob.status === "error" && blacklistCheckJob.error && (
                <span className="text-xs text-destructive">· {blacklistCheckJob.error}</span>
              )}
            </div>
            {blacklistCheckJob.status !== "running" && (
              <button onClick={() => setBlacklistCheckJob(null)} className="text-xs text-muted-foreground hover:text-foreground">Dismiss</button>
            )}
          </div>
        </div>
      )}

      {/* Check Redirects Progress */}
      {redirectCheckJob && (
        <div className="rounded-lg border bg-muted/30 px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              {redirectCheckJob.status === "running" && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
              {redirectCheckJob.status === "done" && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
              {redirectCheckJob.status === "error" && <AlertTriangle className="h-3.5 w-3.5 text-destructive" />}
              <span className="font-medium">
                {redirectCheckJob.status === "running"
                  ? `Checking redirects · ${redirectCheckJob.checked} / ${redirectCheckJob.total}`
                  : redirectCheckJob.status === "done"
                    ? `Checked ${redirectCheckJob.total} domain${redirectCheckJob.total !== 1 ? "s" : ""}`
                    : "Redirect check failed"}
              </span>
              <span className="text-xs text-muted-foreground">{redirectCheckJob.redirects} redirect{redirectCheckJob.redirects !== 1 ? "s" : ""} found</span>
              {redirectCheckJob.status === "error" && redirectCheckJob.error && (
                <span className="text-xs text-destructive">· {redirectCheckJob.error}</span>
              )}
            </div>
            {redirectCheckJob.status !== "running" && (
              <button onClick={() => setRedirectCheckJob(null)} className="text-xs text-muted-foreground hover:text-foreground">Dismiss</button>
            )}
          </div>
        </div>
      )}

      {/* Sync Selected Progress */}
      {syncSelectedJob && (
        <div className="rounded-lg border bg-muted/30 px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              {syncSelectedJob.status === "running" && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
              {syncSelectedJob.status === "done" && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
              {syncSelectedJob.status === "error" && <AlertTriangle className="h-3.5 w-3.5 text-destructive" />}
              <span className="font-medium">
                {syncSelectedJob.status === "running"
                  ? `Syncing ${syncSelectedJob.totalDomains} domain${syncSelectedJob.totalDomains !== 1 ? "s" : ""}...`
                  : syncSelectedJob.status === "done"
                    ? `Synced ${syncSelectedJob.totalDomains} domain${syncSelectedJob.totalDomains !== 1 ? "s" : ""}`
                    : "Sync failed"}
              </span>
              <span className="text-xs text-muted-foreground">{syncSelectedJob.synced} inboxes updated</span>
              {syncSelectedJob.status === "error" && syncSelectedJob.error && (
                <span className="text-xs text-destructive">· {syncSelectedJob.error}</span>
              )}
            </div>
            {syncSelectedJob.status !== "running" && (
              <button onClick={() => setSyncSelectedJob(null)} className="text-xs text-muted-foreground hover:text-foreground">Dismiss</button>
            )}
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
                placeholder="Search domains, comma separated"
                className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
              />
              {domainSearch && (
                <button onClick={() => setDomainSearch("")}>
                  <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                </button>
              )}
            </div>

            {/* Redirect URL search */}
            <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-1.5 min-w-[180px] max-w-[220px]">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input
                value={redirectSearch}
                onChange={(e) => setRedirectSearch(e.target.value)}
                placeholder="Search redirect URL"
                className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
              />
              {redirectSearch && (
                <button onClick={() => setRedirectSearch("")}>
                  <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                </button>
              )}
            </div>

            {/* Tag multi-select */}
            <TagFilterDropdown
              allTags={allTags}
              selected={tagFilters}
              onChange={setTagFilters}
              mode={tagMatchMode}
              onModeChange={setTagMatchMode}
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

            {/* Multi-condition numeric filter */}
            {(() => {
              const activeCount = filterConditions.filter((c) => c.value.trim() !== "").length;
              return (
                <button
                  onClick={() => setShowFilterBuilder((s) => !s)}
                  className={`text-xs px-3 py-1.5 rounded-full border transition-colors flex items-center gap-1.5 ${
                    activeCount > 0
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                  }`}
                >
                  <SlidersHorizontal className="h-3 w-3" />
                  Filters
                  {activeCount > 0 && (
                    <span className="text-[10px] font-medium rounded-full px-1.5 bg-primary-foreground/20">
                      {activeCount}
                    </span>
                  )}
                </button>
              );
            })()}

            {/* Column show/hide */}
            <div className="relative">
              <button
                onClick={() => setShowColumnMenu((s) => !s)}
                className="text-xs px-3 py-1.5 rounded-full border border-border text-muted-foreground hover:border-foreground hover:text-foreground transition-colors flex items-center gap-1.5"
              >
                <SlidersHorizontal className="h-3 w-3 rotate-90" />
                Columns
              </button>
              {showColumnMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowColumnMenu(false)} />
                  <div className="absolute z-20 mt-1 left-0 w-52 rounded-xl border bg-background p-2 shadow-lg">
                    <p className="text-[11px] text-muted-foreground px-1.5 pb-1">Show columns</p>
                    {TABLE_COLUMNS.filter((c) => c.toggleable).map((c) => (
                      <button
                        key={c.field}
                        onClick={() => setColumnVisibility((prev) => ({ ...prev, [c.field]: prev[c.field] === false }))}
                        className="w-full flex items-center gap-2 px-1.5 py-1 rounded-lg hover:bg-muted text-xs"
                      >
                        <span className={`h-3.5 w-3.5 rounded border flex items-center justify-center shrink-0 ${columnVisibility[c.field] !== false ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30"}`}>
                          {columnVisibility[c.field] !== false && <Check className="h-2.5 w-2.5" />}
                        </span>
                        {c.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Trailing-rate warm-up note */}
            {trailingDaysCollected > 0 && trailingDaysCollected < 30 && (
              <span className="text-[11px] text-muted-foreground self-center">
                Trailing rates warming up — day {trailingDaysCollected}/30
              </span>
            )}

            {/* Filter builder panel (own line via w-full inside the flex-wrap row) */}
            {showFilterBuilder && (
              <div className="w-full mt-1 rounded-xl border bg-background p-3 space-y-2">
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Match</span>
                  <div className="flex rounded-lg border overflow-hidden">
                    {(["all", "any"] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => setFilterMatchMode(m)}
                        className={`px-2.5 py-1 transition-colors ${
                          filterMatchMode === m
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {m === "all" ? "ALL (AND)" : "ANY (OR)"}
                      </button>
                    ))}
                  </div>
                  <span className="text-muted-foreground">of these conditions:</span>
                </div>

                {filterConditions.length === 0 && (
                  <p className="text-xs text-muted-foreground/70">No conditions yet — add one below.</p>
                )}

                {filterConditions.map((c) => {
                  const def = filterFieldDef(c.field);
                  return (
                  <div key={c.id} className="flex items-center gap-2 flex-wrap">
                    <select
                      value={c.field}
                      onChange={(e) => {
                        const field = e.target.value as FilterField;
                        const nextDef = filterFieldDef(field);
                        // Field kinds differ → reset op/value to the new kind's defaults.
                        setFilterConditions((prev) => prev.map((x) => x.id === c.id
                          ? { ...x, field, op: defaultOpFor(nextDef), value: defaultValueFor(nextDef) }
                          : x));
                      }}
                      className="text-xs rounded-lg border bg-background px-2 py-1.5 outline-none"
                    >
                      {[...new Set(FILTER_FIELDS.map((f) => f.group))].map((g) => (
                        <optgroup key={g} label={g}>
                          {FILTER_FIELDS.filter((f) => f.group === g).map((f) => (
                            <option key={f.value} value={f.value}>{f.label}</option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    <select
                      value={c.op}
                      onChange={(e) => setFilterConditions((prev) => prev.map((x) => x.id === c.id ? { ...x, op: e.target.value as FilterOp } : x))}
                      className="text-xs rounded-lg border bg-background px-2 py-1.5 outline-none"
                    >
                      {OPS_BY_KIND[def.kind].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    {def.kind === "number" && (
                      <input
                        type="number"
                        value={c.value}
                        onChange={(e) => setFilterConditions((prev) => prev.map((x) => x.id === c.id ? { ...x, value: e.target.value } : x))}
                        placeholder="value"
                        className="text-xs rounded-lg border bg-background px-2 py-1.5 w-24 outline-none"
                      />
                    )}
                    {def.kind === "text" && (
                      <input
                        type="text"
                        value={c.value}
                        onChange={(e) => setFilterConditions((prev) => prev.map((x) => x.id === c.id ? { ...x, value: e.target.value } : x))}
                        placeholder="text…"
                        className="text-xs rounded-lg border bg-background px-2 py-1.5 w-36 outline-none"
                      />
                    )}
                    {def.kind === "boolean" && (
                      <select
                        value={c.value}
                        onChange={(e) => setFilterConditions((prev) => prev.map((x) => x.id === c.id ? { ...x, value: e.target.value } : x))}
                        className="text-xs rounded-lg border bg-background px-2 py-1.5 outline-none"
                      >
                        <option value="yes">Yes</option>
                        <option value="no">No</option>
                      </select>
                    )}
                    {def.kind === "enum" && (
                      <select
                        value={c.value}
                        onChange={(e) => setFilterConditions((prev) => prev.map((x) => x.id === c.id ? { ...x, value: e.target.value } : x))}
                        className="text-xs rounded-lg border bg-background px-2 py-1.5 outline-none"
                      >
                        {(def.options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    )}
                    <button
                      onClick={() => setFilterConditions((prev) => prev.filter((x) => x.id !== c.id))}
                      className="text-muted-foreground hover:text-destructive"
                      title="Remove condition"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  );
                })}

                <div className="flex items-center gap-3 pt-1">
                  {filterConditions.length < 8 ? (
                    <button
                      onClick={() => setFilterConditions((prev) => [...prev, { id: filterIdRef.current++, field: "total_sent", op: ">=", value: "" }])}
                      className="text-xs px-2.5 py-1 rounded-lg border text-muted-foreground hover:text-foreground hover:border-foreground flex items-center gap-1"
                    >
                      <Plus className="h-3 w-3" /> Add condition
                    </button>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">Max 8 conditions</span>
                  )}
                  {filterConditions.length > 0 && (
                    <button
                      onClick={() => setFilterConditions([])}
                      className="text-xs px-2.5 py-1 rounded-lg text-muted-foreground hover:text-destructive"
                    >
                      Clear all
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Flagged filter */}
            <button
              onClick={() => {
                const next = !showFlagged;
                setShowFlagged(next);
                setFlagSubFilter("all");
                if (next) setShowHealthy(false);
              }}
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

            {/* Healthy filter — opposite of Flagged */}
            <button
              onClick={() => {
                const next = !showHealthy;
                setShowHealthy(next);
                if (next) { setShowFlagged(false); setFlagSubFilter("all"); }
              }}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors flex items-center gap-1.5 ${
                showHealthy
                  ? "bg-emerald-500 text-white border-emerald-500"
                  : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
              }`}
            >
              <CheckCircle2 className="h-3 w-3" />
              Healthy
              {healthyCount > 0 && (
                <span className={`text-[10px] font-medium rounded-full px-1.5 ${
                  showHealthy ? "bg-white/20" : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                }`}>
                  {healthyCount}
                </span>
              )}
            </button>

            {/* SURBL Listed filter */}
            <button
              onClick={() => {
                const next = !showBlacklisted;
                setShowBlacklisted(next);
                if (next) setShowNotBlacklisted(false);
              }}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors flex items-center gap-1.5 ${
                showBlacklisted
                  ? "bg-destructive text-destructive-foreground border-destructive"
                  : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
              }`}
            >
              <ShieldAlert className="h-3 w-3" />
              SURBL Listed
              {blacklistedCount > 0 && (
                <span className={`text-[10px] font-medium rounded-full px-1.5 ${
                  showBlacklisted ? "bg-destructive-foreground/20" : "bg-destructive/15 text-destructive"
                }`}>
                  {blacklistedCount}
                </span>
              )}
            </button>

            {/* SURBL Clean filter — confirmed clean on SURBL */}
            <button
              onClick={() => {
                const next = !showNotBlacklisted;
                setShowNotBlacklisted(next);
                if (next) setShowBlacklisted(false);
              }}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors flex items-center gap-1.5 ${
                showNotBlacklisted
                  ? "bg-emerald-500 text-white border-emerald-500"
                  : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
              }`}
            >
              <CheckCircle2 className="h-3 w-3" />
              SURBL Clean
              {notBlacklistedCount > 0 && (
                <span className={`text-[10px] font-medium rounded-full px-1.5 ${
                  showNotBlacklisted ? "bg-white/20" : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                }`}>
                  {notBlacklistedCount}
                </span>
              )}
            </button>

            {/* Spamhaus Listed filter */}
            <button
              onClick={() => {
                const next = !showSpamhausListed;
                setShowSpamhausListed(next);
                if (next) setShowSpamhausClean(false);
              }}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors flex items-center gap-1.5 ${
                showSpamhausListed
                  ? "bg-destructive text-destructive-foreground border-destructive"
                  : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
              }`}
            >
              <ShieldAlert className="h-3 w-3" />
              Spamhaus Listed
              {spamhausListedCount > 0 && (
                <span className={`text-[10px] font-medium rounded-full px-1.5 ${
                  showSpamhausListed ? "bg-destructive-foreground/20" : "bg-destructive/15 text-destructive"
                }`}>
                  {spamhausListedCount}
                </span>
              )}
            </button>

            {/* Spamhaus Clean filter */}
            <button
              onClick={() => {
                const next = !showSpamhausClean;
                setShowSpamhausClean(next);
                if (next) setShowSpamhausListed(false);
              }}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors flex items-center gap-1.5 ${
                showSpamhausClean
                  ? "bg-emerald-500 text-white border-emerald-500"
                  : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
              }`}
            >
              <CheckCircle2 className="h-3 w-3" />
              Spamhaus Clean
              {spamhausCleanCount > 0 && (
                <span className={`text-[10px] font-medium rounded-full px-1.5 ${
                  showSpamhausClean ? "bg-white/20" : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                }`}>
                  {spamhausCleanCount}
                </span>
              )}
            </button>

            {/* Multi-client filter — domain has 2+ client tags */}
            <button
              onClick={() => setShowMultiClient((v) => !v)}
              title="Show domains with 2 or more client tags attached"
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors flex items-center gap-1.5 ${
                showMultiClient
                  ? "bg-amber-500 text-white border-amber-500"
                  : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
              }`}
            >
              <Tags className="h-3 w-3" />
              Multi-client
              {multiClientCount > 0 && (
                <span className={`text-[10px] font-medium rounded-full px-1.5 ${
                  showMultiClient ? "bg-white/20" : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                }`}>
                  {multiClientCount}
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
              onClick={() => { setShowReserve((v) => !v); if (!showReserve) setShowAssigned(false); }}
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

            {/* Assigned filter (opposite of Reserve) */}
            <button
              onClick={() => { setShowAssigned((v) => !v); if (!showAssigned) setShowReserve(false); }}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors flex items-center gap-1.5 ${
                showAssigned
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
              }`}
            >
              Assigned
              {assignedCount > 0 && (
                <span className={`text-[10px] font-medium rounded-full px-1.5 ${
                  showAssigned ? "bg-primary-foreground/20" : "bg-primary/15 text-primary"
                }`}>
                  {assignedCount}
                </span>
              )}
            </button>

            {/* Domain Status dropdown (Inboxing / MilkBox lifecycle). Populated
                by /api/cron/provider-domain-status-check. Rows without a cache
                entry (no Inboxing/Milkbox tag, or not yet checked by the cron)
                render as "Unknown". */}
            <div className="flex items-center gap-1.5 pl-2 ml-1 border-l">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Domain Status</span>
              <Select
                value={providerStatusFilter}
                onValueChange={(v) => setProviderStatusFilter(v as "all" | "active" | "canceled" | "unknown")}
              >
                <SelectTrigger className="h-7 text-xs w-[110px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="canceled">Canceled</SelectItem>
                  <SelectItem value="unknown">Unknown</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Warmup days filter */}
            <div className="flex items-center gap-1">
              {[
                { value: "all", label: "All Warmup" },
                { value: "complete", label: "Complete" },
              ].map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => { setWarmupDaysFilter(opt.value); setWarmupDaysFrom(""); setWarmupDaysTo(""); }}
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
                warmupDaysFrom || warmupDaysTo
                  ? "border-primary text-primary"
                  : "border-border text-muted-foreground"
              }`}>
                <input
                  type="number"
                  min="0"
                  max="21"
                  placeholder="0"
                  value={warmupDaysFrom}
                  onChange={(e) => { setWarmupDaysFrom(e.target.value); setWarmupDaysFilter("all"); }}
                  className="w-6 bg-transparent outline-none text-center tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <span>–</span>
                <input
                  type="number"
                  min="0"
                  max="21"
                  placeholder="21"
                  value={warmupDaysTo}
                  onChange={(e) => { setWarmupDaysTo(e.target.value); setWarmupDaysFilter("all"); }}
                  className="w-6 bg-transparent outline-none text-center tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
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

            {(tagFilters.length > 0 || domainSearch || typeFilter !== "all" || showReserve || showAssigned || warmupDaysFilter !== "all" || warmupDaysFrom || warmupDaysTo) && (
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
              {/* Bulk action bar (admin only) */}
              {isAdmin && selectedDomains.size > 0 && (
                <div className="flex items-start gap-3 rounded-xl border bg-muted/50 px-4 py-2.5">
                  <span className="text-xs font-medium whitespace-nowrap shrink-0 mt-1.5">
                    {selectedDomains.size} domain{selectedDomains.size !== 1 ? "s" : ""} selected
                  </span>
                  <div className="flex flex-wrap items-center justify-end gap-2 ml-auto">
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
                      className="h-7 text-xs gap-1.5"
                      onClick={() => { setLimitDialog({ type: "daily", domains: Array.from(selectedDomains) }); setLimitInput(""); }}
                    >
                      Daily Limit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs gap-1.5"
                      onClick={() => { setLimitDialog({ type: "warmup", domains: Array.from(selectedDomains) }); setLimitInput(""); }}
                    >
                      Warmup Limit
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
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs gap-1.5"
                      onClick={() => startSyncSelected(Array.from(selectedDomains))}
                    >
                      <RefreshCw className="h-3 w-3" />
                      Sync Selected
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs gap-1.5"
                      onClick={() => startCheckRedirects(Array.from(selectedDomains))}
                    >
                      <ExternalLink className="h-3 w-3" />
                      Check Redirects
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs gap-1.5"
                      onClick={() => startCheckBlacklist(Array.from(selectedDomains))}
                      title="Check selected domains against SURBL (multi.surbl.org)"
                    >
                      <ShieldAlert className="h-3 w-3" />
                      Check SURBL
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs gap-1.5"
                      onClick={() => startCheckSpamhaus(Array.from(selectedDomains))}
                      title="Check selected domains against Spamhaus DBL (dbl.spamhaus.org)"
                    >
                      <ShieldAlert className="h-3 w-3" />
                      Check Spamhaus
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs gap-1.5"
                      onClick={() => setChangeRedirectOpen(true)}
                      title="Bulk-change the redirect URL via each domain's provider (MilkBox / Inboxing / ScaledMail)"
                    >
                      <Link2 className="h-3 w-3" />
                      Change Redirect
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs gap-1.5"
                      onClick={() => setMoveDialogOpen(true)}
                      disabled={moveProgress?.running || moveProgress?.queued}
                      title="Move Inboxing domains' inboxes to another Bison instance (tags sync → Inboxing platform upload → source cleanup)"
                    >
                      <ArrowRightLeft className="h-3 w-3" />
                      Move to Instance
                    </Button>
                    <div className="relative">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1.5"
                        onClick={(e) => { e.stopPropagation(); setShowExportMenu((v) => !v); }}
                      >
                        <Download className="h-3 w-3" />
                        Export
                      </Button>
                      {showExportMenu && (
                        <div className="absolute top-full right-0 mt-1 z-50 rounded-lg border bg-popover shadow-md py-1 min-w-[160px]" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={copyDomainsToClipboard}
                            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-muted transition-colors"
                          >
                            <Copy className="h-3 w-3" />
                            {exportCopied ? "Copied!" : "Copy Domains"}
                          </button>
                          <button
                            onClick={() => exportDomainsCsv(false)}
                            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-muted transition-colors"
                          >
                            <Download className="h-3 w-3" />
                            Download CSV
                          </button>
                          <button
                            onClick={() => exportDomainsCsv(true)}
                            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-muted transition-colors"
                          >
                            <Download className="h-3 w-3" />
                            Download CSV (with stats)
                          </button>
                        </div>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs gap-1.5"
                      onClick={() => setShowSendToSheet(true)}
                    >
                      <Send className="h-3 w-3" />
                      Whitelist
                    </Button>
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
              <div className="grid gap-2 px-4 py-2 text-xs text-muted-foreground font-medium" style={{ gridTemplateColumns }}>
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
                {(() => {
                  const cols = visibleColumns;
                  const renderSort = (col: (typeof cols)[number]) => (
                    <button
                      key={col.field}
                      onClick={() => {
                        if (sortField === col.field) {
                          if (sortDir === "desc") setSortDir("asc");
                          else { setSortField(null); setSortDir("desc"); }
                        } else {
                          setSortField(col.field);
                          setSortDir("desc");
                        }
                      }}
                      className={`${col.align} hover:text-foreground transition-colors flex items-center gap-0.5 ${col.align === "text-center" ? "justify-center" : ""}`}
                    >
                      {col.label}
                      {sortField === col.field && (
                        sortDir === "desc" ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />
                      )}
                    </button>
                  );
                  return <>{cols.map(renderSort)}</>;
                })()}
              </div>
              {filteredDomains.map((d, domainIdx) => {
                const daysOld = d.domain_created_at
                  ? Math.floor((now - new Date(d.domain_created_at).getTime()) / (1000 * 60 * 60 * 24))
                  : 0;
                const warmupDaysLeft = Math.max(0, 21 - daysOld);
                const replyRate = (d.total_sent || 0) > 0
                  ? ((d.total_replied || 0) / (d.total_sent || 1) * 100).toFixed(1)
                  : "0.0";
                const bounceRate = (d.total_sent || 0) > 0
                  ? ((d.total_bounced || 0) / (d.total_sent || 1) * 100).toFixed(1)
                  : "0.0";
                const lowReply = (d.total_sent || 0) > 100 && (d.total_replied || 0) / (d.total_sent || 1) < 0.01;
                const highBounce = (d.total_sent || 0) > 100 && (d.total_bounced || 0) / (d.total_sent || 1) > 0.03;
                // Trailing rates only meaningful once the domain has sent enough — hide until >50 total sent.
                const trailingReady = (d.total_sent || 0) > 50;

                // Flagging rules
                const isGoogleDomain = (d.google_count || 0) > 0 && (d.outlook_count || 0) === 0;
                const isOutlookDomain = (d.outlook_count || 0) > 0 && (d.google_count || 0) === 0;
                const flagReasons = getFlagReasons(d);
                const flagged = flagReasons.length > 0;

                const isSelected = selectedDomains.has(d.domain);

                return (
                  <div
                    key={`${d.instance}:${d.domain}`}
                    onMouseEnter={() => handleDragEnter(domainIdx, filteredDomains)}
                    style={{ gridTemplateColumns }}
                    className={`grid gap-2 items-center rounded-xl border px-4 py-3 transition-colors select-none ${
                      isSelected
                        ? "bg-primary/5 border-primary/30"
                        : flagged
                          ? "bg-destructive/5 border-destructive/30 hover:bg-destructive/10"
                          : "bg-card hover:bg-muted/30"
                    }`}
                  >
                    {/* Checkbox — supports drag-to-select */}
                    <button
                      onMouseDown={(e) => { e.preventDefault(); handleDragStart(domainIdx, d.domain); }}
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
                      <div className="flex items-center gap-1.5 mt-1 ml-5 flex-wrap">
                        {d.tags?.map((t) => (
                          <span key={t} className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">{t}</span>
                        ))}
                      </div>
                    </div>

                    {/* Blacklisted (SURBL) */}
                    {isColVisible("blacklisted") && (
                    <div className="text-center text-xs">
                      {d.blacklisted === true ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-destructive/15 text-destructive font-medium">
                              true
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="top">Listed on SURBL · checked {d.blacklist_checked_at ? new Date(d.blacklist_checked_at).toLocaleString() : ""}</TooltipContent>
                        </Tooltip>
                      ) : d.blacklisted === false ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500 font-medium">
                              false
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="top">Not listed · checked {d.blacklist_checked_at ? new Date(d.blacklist_checked_at).toLocaleString() : ""}</TooltipContent>
                        </Tooltip>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </div>
                    )}

                    {/* Spamhaus DBL */}
                    {isColVisible("spamhaus_dbl") && (
                    <div className="text-center text-xs">
                      {d.spamhaus_dbl === true ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-destructive/15 text-destructive font-medium">
                              true
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="top">Listed on Spamhaus DBL · checked {d.spamhaus_checked_at ? new Date(d.spamhaus_checked_at).toLocaleString() : ""}</TooltipContent>
                        </Tooltip>
                      ) : d.spamhaus_dbl === false ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500 font-medium">
                              false
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="top">Not listed · checked {d.spamhaus_checked_at ? new Date(d.spamhaus_checked_at).toLocaleString() : ""}</TooltipContent>
                        </Tooltip>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </div>
                    )}

                    {/* Redirect URL */}
                    {isColVisible("redirect_url") && (
                    <div className="min-w-0 text-xs">
                      {d.redirect_url ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <a
                              href={d.redirect_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary hover:underline truncate block max-w-[170px]"
                            >
                              {d.redirect_url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                            </a>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-md break-all">
                            {d.redirect_url}
                          </TooltipContent>
                        </Tooltip>
                      ) : d.redirect_checked_at ? (
                        <span className="text-muted-foreground/60">no redirect</span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </div>
                    )}

                    {/* Provider lifecycle status (Inboxing / MilkBox). Missing
                        entry = domain lacks the Inboxing/Milkbox tag OR the
                        daily cron hasn't caught it yet → render as em-dash. */}
                    {isColVisible("provider_status") && (
                    <div className="text-center text-xs">
                      {(() => {
                        const entry = providerStatusMap[`${d.instance}:${d.domain}`];
                        if (!entry) {
                          return <span className="text-muted-foreground/40" title="Not checked">—</span>;
                        }
                        const raw = entry.raw_status || entry.status;
                        const tooltip = `${entry.provider} · ${raw}${entry.failure_reason ? ` — ${entry.failure_reason}` : ""} · checked ${new Date(entry.checked_at).toLocaleString()}`;
                        if (entry.status === "active") {
                          return (
                            <span
                              className="inline-flex items-center px-1.5 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-950/20 text-emerald-300 text-[10px]"
                              title={tooltip}
                            >
                              Active
                            </span>
                          );
                        }
                        return (
                          <span
                            className="inline-flex items-center px-1.5 py-0.5 rounded-full border border-red-500/30 bg-red-950/20 text-red-300 text-[10px]"
                            title={tooltip}
                          >
                            Canceled
                          </span>
                        );
                      })()}
                    </div>
                    )}

                    {/* Instances the domain exists in (across ALL 4, not just
                        the current sidebar scope) */}
                    {isColVisible("instances") && (
                    <div className="text-center text-xs">
                      <div className="flex items-center justify-center gap-1 flex-wrap">
                        {(domainInstancesMap[d.domain] ?? [d.instance]).map((slug) => (
                          <span
                            key={slug}
                            className={`inline-flex items-center px-1.5 py-0.5 rounded-full border text-[10px] ${
                              slug === d.instance
                                ? "border-primary/40 bg-primary/10 text-foreground"
                                : "border-muted-foreground/25 text-muted-foreground"
                            }`}
                            title={BISON_INSTANCES[slug as BisonInstanceSlug]?.label ?? slug}
                          >
                            {INSTANCE_SHORT_LABELS[slug as BisonInstanceSlug] ?? slug}
                          </span>
                        ))}
                      </div>
                    </div>
                    )}

                    {/* Inbox counts */}
                    {isColVisible("inbox_count") && (
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
                    )}

                    {/* Sent */}
                    {isColVisible("total_sent") && (
                    <div className="text-center text-sm font-medium">
                      {(d.total_sent || 0).toLocaleString()}
                    </div>
                    )}

                    {/* Replied */}
                    {isColVisible("total_replied") && (
                    <div className={`text-center text-sm font-medium ${lowReply ? "text-destructive" : ""}`}>
                      {(d.total_replied || 0).toLocaleString()}
                    </div>
                    )}

                    {/* Reply Rate */}
                    {isColVisible("reply_rate") && (
                    <div className={`text-center text-sm tabular-nums ${lowReply ? "text-destructive" : "text-muted-foreground"}`}>
                      {replyRate}%
                    </div>
                    )}

                    {/* Trailing reply rate (10d / 15d / 30d) — hidden until >50 sent */}
                    {isColVisible("reply_trailing") && (
                    <div className="text-center text-xs tabular-nums text-muted-foreground">
                      {trailingReady ? (<>
                        <span className={d.reply_10 != null && d.reply_10 < 2 ? "text-destructive" : ""}>
                          {d.reply_10 != null ? `${d.reply_10}%` : "—"}
                        </span>
                        <span className="text-muted-foreground/40"> / </span>
                        <span className={d.reply_15 != null && d.reply_15 < 2 ? "text-destructive" : ""}>
                          {d.reply_15 != null ? `${d.reply_15}%` : "—"}
                        </span>
                        <span className="text-muted-foreground/40"> / </span>
                        <span className={d.reply_30 != null && d.reply_30 < 2 ? "text-destructive" : ""}>
                          {d.reply_30 != null ? `${d.reply_30}%` : "—"}
                        </span>
                      </>) : "—"}
                    </div>
                    )}

                    {/* Bounced */}
                    {isColVisible("total_bounced") && (
                    <div className={`text-center text-sm font-medium ${highBounce ? "text-destructive" : ""}`}>
                      {(d.total_bounced || 0).toLocaleString()}
                    </div>
                    )}

                    {/* Bounce Rate */}
                    {isColVisible("bounce_rate") && (
                    <div className={`text-center text-sm tabular-nums ${highBounce ? "text-destructive" : "text-muted-foreground"}`}>
                      {bounceRate}%
                    </div>
                    )}

                    {/* Trailing bounce rate (10d / 15d / 30d) — hidden until >50 sent */}
                    {isColVisible("bounce_trailing") && (
                    <div className="text-center text-xs tabular-nums text-muted-foreground">
                      {trailingReady ? (<>
                        <span className={d.bounce_10 != null && d.bounce_10 > 5 ? "text-destructive" : ""}>
                          {d.bounce_10 != null ? `${d.bounce_10}%` : "—"}
                        </span>
                        <span className="text-muted-foreground/40"> / </span>
                        <span className={d.bounce_15 != null && d.bounce_15 > 5 ? "text-destructive" : ""}>
                          {d.bounce_15 != null ? `${d.bounce_15}%` : "—"}
                        </span>
                        <span className="text-muted-foreground/40"> / </span>
                        <span className={d.bounce_30 != null && d.bounce_30 > 5 ? "text-destructive" : ""}>
                          {d.bounce_30 != null ? `${d.bounce_30}%` : "—"}
                        </span>
                      </>) : "—"}
                    </div>
                    )}

                    {/* Daily Limit */}
                    {isColVisible("daily_limit") && (
                    <div className="text-center text-sm tabular-nums text-muted-foreground">
                      {d.daily_limit_total || 0}
                    </div>
                    )}

                    {/* Warmup status */}
                    {isColVisible("warmup_days") && (
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
                    )}
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
              mode={tagMatchMode}
              onModeChange={setTagMatchMode}
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

          {/* Bulk action bar for warmup (admin only) */}
          {isAdmin && selectedDomains.size > 0 && (
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
                    key={`${d.instance}:${d.domain}`}
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
      <AttachCampaignsDialog open={attachDialogOpen} onOpenChange={setAttachDialogOpen} instancesQuery={instancesQuery} />

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
        selectedDomains={selectedDomainsList}
        onComplete={() => setSelectedDomains(new Set())}
      />

      {/* Conform Tags Dialog — pushes each domain's tags down to its senders */}
      <ConformTagsDialog
        open={conformTagsOpen}
        onOpenChange={setConformTagsOpen}
        instancesQuery={instancesQuery}
        onComplete={() => { loadDomains(); loadTags(); }}
      />

      {/* Change Redirect Dialog — bulk redirect URL update via each domain's provider */}
      <ChangeRedirectDialog
        open={changeRedirectOpen}
        onOpenChange={setChangeRedirectOpen}
        selectedDomains={Array.from(selectedDomains)}
        onComplete={() => loadDomains()}
      />

      {/* Move to Instance — Inboxing domains only; the dialog collects the
          target + connection, then runMoveDomains drives the batched apply
          with live progress in the top panel */}
      <MoveDomainsDialog
        open={moveDialogOpen}
        onOpenChange={setMoveDialogOpen}
        selectedDomains={Array.from(selectedDomains)}
        onStart={runMoveDomains}
      />

      {/* Send to Sheet Dialog */}
      <SendToSheetDialog
        open={showSendToSheet}
        onOpenChange={setShowSendToSheet}
        selectedDomains={Array.from(selectedDomains)}
        domainTags={(() => {
          const tags: string[] = [];
          for (const domain of selectedDomains) {
            const d = domains.find((dd) => dd.domain === domain);
            if (d?.tags) tags.push(...d.tags);
          }
          return tags;
        })()}
        onConfirm={({ domains: doms, clientTag }) => {
          startBackgroundSheetAppend(doms, clientTag);
        }}
      />

      {/* Bulk Limit Update Dialog */}
      {limitDialog && (
        <Dialog open={!!limitDialog} onOpenChange={(v) => { if (!v) setLimitDialog(null); }}>
          <DialogContent className="sm:!max-w-sm">
            <DialogHeader>
              <DialogTitle>
                Update {limitDialog.type === "daily" ? "Daily Sending" : "Warmup"} Limit
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-2">
              <p className="text-sm text-muted-foreground">
                Set the {limitDialog.type === "daily" ? "daily sending" : "daily warmup"} limit for all inboxes across {limitDialog.domains.length} domain{limitDialog.domains.length !== 1 ? "s" : ""}.
              </p>
              <div className="flex items-center gap-3">
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={limitInput}
                  onChange={(e) => setLimitInput(e.target.value)}
                  placeholder="Enter limit..."
                  autoFocus
                  className="flex-1 rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30 tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && limitInput && parseInt(limitInput) > 0) {
                      startBulkLimitUpdate(limitDialog.type, parseInt(limitInput), limitDialog.domains);
                      setLimitDialog(null);
                    }
                  }}
                />
                <span className="text-sm text-muted-foreground whitespace-nowrap">per day</span>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setLimitDialog(null)}>Cancel</Button>
                <Button
                  size="sm"
                  disabled={!limitInput || parseInt(limitInput) <= 0}
                  onClick={() => {
                    startBulkLimitUpdate(limitDialog.type, parseInt(limitInput), limitDialog.domains);
                    setLimitDialog(null);
                  }}
                >
                  Update Limit
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
