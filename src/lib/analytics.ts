import type { Lead } from "@/types/lead";
import type { DashboardAnalytics } from "@/types/analytics";

function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of items) {
    const k = keyFn(item) || "Unknown";
    if (!result[k]) result[k] = [];
    result[k].push(item);
  }
  return result;
}

export function parseDate(dateStr: string): Date | null {
  if (!dateStr) return null;

  // Try standard parsing first (handles ISO, "3/9/2026", "3/9/2026 14:30:00", etc.)
  let d = new Date(dateStr);
  if (!isNaN(d.getTime())) return d;

  // Node.js cannot parse 12-hour AM/PM format that Google Sheets commonly returns
  // e.g. "3/9/2026 2:30:00 PM" or "3/9/2026 2:30 PM"
  const amPmMatch = dateStr.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i
  );
  if (amPmMatch) {
    const [, month, day, year, hourStr, min, sec, amPm] = amPmMatch;
    let hour = parseInt(hourStr, 10);
    if (amPm.toUpperCase() === "PM" && hour !== 12) hour += 12;
    if (amPm.toUpperCase() === "AM" && hour === 12) hour = 0;
    d = new Date(
      `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${String(hour).padStart(2, "0")}:${min}:${sec ?? "00"}`
    );
    return isNaN(d.getTime()) ? null : d;
  }

  return null;
}

/**
 * A lead counts as the client's "deliverable" if the client uses meeting-ready
 * categories (`currentCategory` includes "meeting"). For clients whose sheets
 * never populate `currentCategory` (e.g. BHS), fall back to status === "Quality Lead".
 */
export function makeDeliverablePredicate(leads: Lead[]): (l: Lead) => boolean {
  const usesMeetingCategory = leads.some((l) =>
    (l.currentCategory || "").toLowerCase().includes("meeting")
  );
  if (usesMeetingCategory) {
    return (l) => (l.currentCategory || "").toLowerCase().includes("meeting");
  }
  return (l) => l.status.trim().toLowerCase() === "quality lead";
}

function computeTimeSeries(
  leads: Lead[],
  goLiveDate?: Date | null,
  isDeliverable?: (l: Lead) => boolean
): { date: string; count: number }[] {
  const byMonth: Record<string, number> = {};
  const predicate = isDeliverable || makeDeliverablePredicate(leads);

  for (const lead of leads) {
    // When billing cycle is active, only count "deliverable" leads
    if (goLiveDate && !predicate(lead)) continue;

    const d = parseDate(lead.timeWeGotReply) || parseDate(lead.replyTime);
    if (!d) continue;

    if (goLiveDate) {
      // Group by billing cycle: goLiveDate.day → next month's goLiveDate.day
      if (d < goLiveDate) continue; // skip pre-launch leads
      const startDay = goLiveDate.getDate();
      let monthDiff = (d.getFullYear() - goLiveDate.getFullYear()) * 12 + (d.getMonth() - goLiveDate.getMonth());
      if (d.getDate() < startDay) monthDiff--;
      const billingMonth = monthDiff + 1;
      if (billingMonth < 1) continue;
      const key = `Month ${billingMonth}`;
      byMonth[key] = (byMonth[key] || 0) + 1;
    } else {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      byMonth[key] = (byMonth[key] || 0) + 1;
    }
  }

  if (goLiveDate) {
    // Find the max billing month and fill gaps (so Month 1 always shows even if 0)
    const monthNums = Object.keys(byMonth).map((k) => parseInt(k.replace("Month ", ""), 10));
    const maxMonth = monthNums.length > 0 ? Math.max(...monthNums) : 0;
    const result: { date: string; count: number }[] = [];
    for (let m = 1; m <= Math.max(maxMonth, 1); m++) {
      result.push({ date: `Month ${m}`, count: byMonth[`Month ${m}`] || 0 });
    }
    return result;
  }

  return Object.entries(byMonth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));
}

// Status values can be comma-separated (multi-select in Google Sheets).
// For "Quality Lead" counting, we only count leads with EXACTLY "Quality Lead"
// as the sole status (no mixed statuses).
const KNOWN_STATUSES: [string, string][] = [
  ["quality lead", "Quality Lead"],
  ["not a quality lead", "Not a Quality Lead"],
  ["lead not received", "Lead not Received"],
  ["duplicated", "Duplicated"],
  ["duplicate", "Duplicated"],
  ["duplicate.", "Duplicated"],
  ["undetermined", "Undetermined"],
];

function normalizeStatus(raw: string): string {
  const s = raw.trim();
  if (!s) return "";

  // Check if it's a single, clean value first
  const lower = s.toLowerCase();
  for (const [pattern, normalized] of KNOWN_STATUSES) {
    if (lower === pattern) return normalized;
  }

  // Handle comma-separated multi-select values
  const parts = s.split(",").map((p) => p.trim().toLowerCase());
  if (parts.length > 1) {
    // Multiple statuses selected — find all recognized ones
    const recognized: string[] = [];
    for (const part of parts) {
      for (const [pattern, normalized] of KNOWN_STATUSES) {
        if (part === pattern) {
          recognized.push(normalized);
          break;
        }
      }
    }
    // If multiple different statuses, mark as the non-quality one
    // (e.g. "Quality Lead, Not a Quality Lead" = "Not a Quality Lead")
    if (recognized.length > 1) {
      // Prefer non-"Quality Lead" when mixed
      const nonQuality = recognized.find((r) => r !== "Quality Lead");
      return nonQuality || recognized[0];
    }
    if (recognized.length === 1) return recognized[0];
  }

  return s;
}

export function computeAnalytics(
  leads: Lead[],
  filterClientTag?: string,
  excludeClientTags?: string[],
  goLiveDate?: Date | null,
  // Per-client data freshness (oldest sheet syncedAt). Lets the stale-clients
  // panel mark clients whose lead data hasn't refreshed recently, so frozen
  // snapshots are never silently presented as current.
  syncedAtByClient?: Record<string, string>
): DashboardAnalytics {
  const baseLeads = excludeClientTags?.length
    ? leads.filter((l) => !excludeClientTags.includes(l.sheetClientTag))
    : leads;

  const filtered = filterClientTag
    ? baseLeads.filter((l) => l.clientTag === filterClientTag)
    : baseLeads;

  const totalLeads = filtered.length;

  const withNormalized = filtered.map((l) => ({
    ...l,
    _status: normalizeStatus(l.status),
  }));

  const qualityLeads = withNormalized.filter((l) => l._status === "Quality Lead").length;
  const notQualityLeads = withNormalized.filter((l) => l._status === "Not a Quality Lead").length;
  const undeterminedLeads = withNormalized.filter((l) => l._status === "Undetermined").length;
  const leadNotReceived = withNormalized.filter((l) => l._status === "Lead not Received").length;
  const duplicated = withNormalized.filter((l) => l._status === "Duplicated").length;

  // Per-client adaptive predicate: most clients tag leads via `currentCategory`,
  // but some (e.g. BHS) leave it empty and rely on `status` only. Falling back
  // to status === "Quality Lead" lets those clients show on the time chart.
  const isDeliverable = makeDeliverablePredicate(filtered);
  const meetingReadyLeads = filtered.filter(isDeliverable).length;
  const interestedLeads = filtered.filter(
    (l) => l.currentCategory.toLowerCase() === "interested"
  ).length;

  // Helper to check if a client tag is valid
  const isValidClientTag = (tag: string): boolean => {
    const lower = tag.toLowerCase().trim();
    if (!lower || lower === "unknown") return false;
    if (lower.includes("@")) return false;

    const invalidPatterns = [
      "meeting-ready", "meeting ready", "meeting",
      "interested", "not interested",
      "quality lead", "not a quality lead", "undetermined",
      "duplicated", "duplicate", "lead not received"
    ];

    if (lower === "lead") return false;

    return !invalidPatterns.some(pattern => {
      if (pattern === "meeting") {
        return lower === "meeting" || lower.startsWith("meeting-") || lower.startsWith("meeting ");
      }
      return lower.includes(pattern);
    });
  };

  // Group by sheetClientTag — this merges multiple sheets for the same client
  const byClient = groupBy(filtered, (l) => l.sheetClientTag);
  const leadsByClient = Object.entries(byClient)
    .filter(([client]) => isValidClientTag(client))
    .map(([client, items]) => ({ client, count: items.length }))
    .sort((a, b) => b.count - a.count);

  const byStatus = groupBy(withNormalized, (l) => l._status);
  const VALID_STATUSES = [
    "Quality Lead",
    "Not a Quality Lead",
    "Lead not Received",
    "Duplicated",
    "Undetermined",
  ];
  const leadsByStatus = Object.entries(byStatus)
    .filter(([status]) => VALID_STATUSES.includes(status))
    .map(([status, items]) => ({ status, count: items.length }))
    .sort((a, b) => b.count - a.count);

  const byCategory = groupBy(filtered, (l) => l.currentCategory);
  const leadsByCategory = Object.entries(byCategory)
    .filter(([cat]) => cat !== "Unknown" && cat !== "")
    .map(([category, items]) => ({ category, count: items.length }))
    .sort((a, b) => b.count - a.count);

  const leadsOverTime = computeTimeSeries(filtered, goLiveDate, isDeliverable);
  // Parallel series scoped to leads whose canonical status is "Quality Lead" —
  // lets the client detail page contrast Meeting-Ready vs Quality on the
  // same axis. Uses the same billing-month bucketing so both lines align.
  const isQualityLead = (l: Lead) => l.status.trim().toLowerCase() === "quality lead";
  const qualityLeadsOverTime = computeTimeSeries(filtered, goLiveDate, isQualityLead);

  const topClients = leadsByClient
    .map(({ client, count }) => {
      const clientLeads = byClient[client] || [];
      const quality = clientLeads.filter((l) => {
        const raw = l.status.trim().toLowerCase();
        return raw === "quality lead";
      }).length;
      return {
        client,
        qualityLeads: quality,
        totalLeads: count,
        percentage: count > 0 ? Math.round((quality / count) * 100) : 0,
      };
    })
    .filter((c) => isValidClientTag(c.client))
    .sort((a, b) => b.totalLeads - a.totalLeads);

  // Meeting-ready leads delivered in past 24 hours (PST)
  const now = new Date();
  const pstOffset = -8 * 60; // PST is UTC-8
  const nowPst = new Date(now.getTime() + (pstOffset + now.getTimezoneOffset()) * 60000);
  const twentyFourHoursAgoPst = new Date(nowPst.getTime() - 24 * 60 * 60 * 1000);

  const meetingReadyLast24h = filtered.filter((l) => {
    if (!isDeliverable(l)) return false;
    const replyDate = parseDate(l.timeWeGotReply) || parseDate(l.replyTime);
    if (!replyDate) return false;
    const replyPst = new Date(replyDate.getTime() + (pstOffset + replyDate.getTimezoneOffset()) * 60000);
    return replyPst >= twentyFourHoursAgoPst;
  }).length;

  // "Deliverable" leads without a status — same predicate, just no status
  const meetingReadyNoStatus = filtered.filter(
    (l) =>
      isDeliverable(l) &&
      !l.status.trim()
  );
  const meetingReadyWithoutStatus = meetingReadyNoStatus.length;
  const meetingReadyWithoutStatusTotal = meetingReadyLeads;

  // Clients without meeting-ready leads for 4+ days (PST)
  const fourDaysAgoPst = new Date(nowPst.getTime() - 4 * 24 * 60 * 60 * 1000);
  // A client's data is "stale" if its sheet hasn't re-synced within this many
  // hours — such rows are shown but badged, never trusted as fresh.
  const STALE_HOURS = 30;
  const clientsWithoutRecentMeetingReady: { client: string; lastMeetingReadyDate: string | null; dataSyncedAt: string | null; stale: boolean }[] = [];

  for (const [client, clientLeads] of Object.entries(byClient)) {
    // Skip invalid client tags
    if (!isValidClientTag(client)) {
      continue;
    }

    // Per-client deliverable predicate (same fallback as elsewhere)
    const clientDeliverable = makeDeliverablePredicate(clientLeads);

    // Find the most recent deliverable lead date for this client
    let lastMeetingReadyDate: Date | null = null;
    let hasRecentMeetingReady = false;

    for (const l of clientLeads) {
      if (!clientDeliverable(l)) continue;
      const replyDate = parseDate(l.timeWeGotReply) || parseDate(l.replyTime);
      if (!replyDate) continue;

      if (!lastMeetingReadyDate || replyDate > lastMeetingReadyDate) {
        lastMeetingReadyDate = replyDate;
      }

      const replyPst = new Date(replyDate.getTime() + (pstOffset + replyDate.getTimezoneOffset()) * 60000);
      if (replyPst >= fourDaysAgoPst) {
        hasRecentMeetingReady = true;
      }
    }

    if (!hasRecentMeetingReady) {
      const dataSyncedAt = syncedAtByClient?.[client] ?? null;
      const stale = dataSyncedAt
        ? (Date.now() - new Date(dataSyncedAt).getTime()) > STALE_HOURS * 3600_000
        : true; // no freshness info → treat as stale (don't over-trust)
      clientsWithoutRecentMeetingReady.push({
        client,
        lastMeetingReadyDate: lastMeetingReadyDate ? lastMeetingReadyDate.toISOString() : null,
        dataSyncedAt,
        stale,
      });
    }
  }

  return {
    totalLeads,
    qualityLeads,
    notQualityLeads,
    undeterminedLeads,
    leadNotReceived,
    duplicated,
    qualityLeadPercentage:
      totalLeads > 0 ? Math.round((qualityLeads / totalLeads) * 100) : 0,
    meetingReadyLeads,
    interestedLeads,
    meetingReadyLast24h,
    meetingReadyWithoutStatus,
    meetingReadyWithoutStatusTotal,
    clientsWithoutRecentMeetingReady,
    leadsByClient,
    leadsByStatus,
    leadsByCategory,
    leadsOverTime,
    qualityLeadsOverTime,
    topClients,
  };
}
