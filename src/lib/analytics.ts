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

function parseDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

function computeTimeSeries(leads: Lead[]): { date: string; count: number }[] {
  const byMonth: Record<string, number> = {};

  for (const lead of leads) {
    const d = parseDate(lead.timeWeGotReply) || parseDate(lead.replyTime);
    if (!d) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    byMonth[key] = (byMonth[key] || 0) + 1;
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
  filterClientTag?: string
): DashboardAnalytics {
  const filtered = filterClientTag
    ? leads.filter((l) => l.clientTag === filterClientTag)
    : leads;

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

  const meetingReadyLeads = filtered.filter((l) =>
    l.currentCategory.toLowerCase().includes("meeting")
  ).length;
  const interestedLeads = filtered.filter(
    (l) => l.currentCategory.toLowerCase() === "interested"
  ).length;

  // Group by clientTag — this merges multiple sheets for the same client
  const byClient = groupBy(filtered, (l) => l.clientTag);
  const leadsByClient = Object.entries(byClient)
    .filter(([client]) => client !== "Unknown" && client !== "")
    .map(([client, items]) => ({ client, count: items.length }))
    .sort((a, b) => b.count - a.count);

  const byStatus = groupBy(withNormalized, (l) => l._status);
  const leadsByStatus = Object.entries(byStatus)
    .filter(([status]) => status !== "" && status !== "Unknown")
    .map(([status, items]) => ({ status, count: items.length }))
    .sort((a, b) => b.count - a.count);

  const byCategory = groupBy(filtered, (l) => l.currentCategory);
  const leadsByCategory = Object.entries(byCategory)
    .filter(([cat]) => cat !== "Unknown" && cat !== "")
    .map(([category, items]) => ({ category, count: items.length }))
    .sort((a, b) => b.count - a.count);

  const leadsOverTime = computeTimeSeries(filtered);

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
    .sort((a, b) => b.totalLeads - a.totalLeads)
    .slice(0, 10);

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
    leadsByClient,
    leadsByStatus,
    leadsByCategory,
    leadsOverTime,
    topClients,
  };
}
