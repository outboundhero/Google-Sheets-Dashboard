import { getConfig } from "@/lib/sheets-config";
import { getLeadsFromSheet, getSheetsClient } from "@/lib/google-sheets";
import { pstDateString } from "@/lib/date-utils";
import type { Lead } from "@/types/lead";

// Automated client performance reports (daily + weekly). Built here, delivered
// by POSTing the payload to the n8n webhook (N8N_CLIENT_REPORT_WEBHOOK_URL),
// whose Gmail node sends the plain-text email — same pattern as the existing
// daily-account-status-report.

const CLIENT_TRACKER_SHEET_ID = "1MGqSgGNoeN6WgjZnT7_Ij_nZftyyj7Z9DT77rVYLKuQ";
const CLIENT_TRACKER_TAB = "Client Tracker";

// Average weighted days in a month: weekdays count 1, weekends 0.5.
// 30.44 cal days/month × (5/7 + 0.5×2/7) = 30.44 × 6/7 ≈ 26.1
const WEIGHTED_DAYS_PER_MONTH = 26.1;
const DAYS_PER_MONTH = 30.44;
const FLAG_THRESHOLD = 0.75; // flagged when actual < 75% of pace (i.e. ≥25% behind)

export type TierBucket = "T0.5/1" | "T2";
const TARGETS: Record<TierBucket, { mrMonthly: number; qlMonthly: number }> = {
  "T0.5/1": { mrMonthly: 20, qlMonthly: 15 },
  "T2": { mrMonthly: 40, qlMonthly: 30 },
};
const BUCKET_LABEL: Record<TierBucket, string> = {
  "T0.5/1": "Tier 0.5 + 1",
  "T2": "Tier 2",
};

function tierBucketFromPlan(plan: string): TierBucket | null {
  const p = plan.toLowerCase();
  if (p.includes("tier 0.5") || p.includes("tier 1")) return "T0.5/1";
  if (p.includes("tier 2")) return "T2";
  return null; // PPQM / PPQL / blank → not a tiered client
}

interface TrackerEntry { plan: string; status: string; bucket: TierBucket | null }

// Read Client Tracker → map of UPPERCASE Client Abbreviation → tier/status.
export async function getClientTierMap(): Promise<Map<string, TrackerEntry>> {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: CLIENT_TRACKER_SHEET_ID,
    range: `'${CLIENT_TRACKER_TAB}'!A1:W`,
    valueRenderOption: "FORMATTED_VALUE",
  });
  const rows = res.data.values || [];
  if (rows.length < 2) return new Map();
  const hdr = rows[0].map((h: string) => String(h).toLowerCase().trim());
  const abbrI = hdr.findIndex((h: string) => h.includes("abbrev"));
  const planI = hdr.indexOf("plan");
  const statusI = hdr.indexOf("status");
  const map = new Map<string, TrackerEntry>();
  for (const r of rows.slice(1)) {
    const abbr = String(r[abbrI] || "").trim().toUpperCase();
    if (!abbr) continue;
    const plan = String(r[planI] || "").trim();
    map.set(abbr, { plan, status: String(r[statusI] || "").trim(), bucket: tierBucketFromPlan(plan) });
  }
  return map;
}

// Resolve a lead-sheet clientTag to its tracker entry. Tags can be combined
// markets ("JPCIN / JPCHI", "DBSM/DBSA", "TM & VC") — try the whole tag first,
// then each part split on "/" and " & " (the codebase keeps "&"-without-spaces
// abbreviations like K&LCS / TM&VC intact).
function resolveTier(clientTag: string, map: Map<string, TrackerEntry>): TrackerEntry | null {
  const candidates = new Set<string>();
  candidates.add(clientTag.trim().toUpperCase());
  for (const slash of clientTag.split("/")) {
    for (const amp of slash.split(" & ")) {
      const v = amp.trim().toUpperCase();
      if (v) candidates.add(v);
    }
  }
  for (const c of candidates) {
    const hit = map.get(c);
    if (hit) return hit;
  }
  return null;
}

function isMeetingReady(l: Lead): boolean {
  return (l.currentCategory || "").trim().toLowerCase() === "meeting-ready lead";
}

// QL = status has a "Quality Lead" part (incl. "Quality Lead (Appointment …)"),
// but NOT "Not a Quality Lead". Status can be a comma-joined compound.
function isQualityLead(l: Lead): boolean {
  const parts = String(l.status || "").toLowerCase().split(",").map((p) => p.trim());
  return parts.some((p) => p === "quality lead" || p.startsWith("quality lead ("));
}

function leadDeliveredOn(l: Lead, dateStr: string): boolean {
  const raw = l.timeWeGotReply || l.replyTime;
  if (!raw) return false;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return false;
  return pstDateString(d) === dateStr;
}

function isWeekend(dateStr: string): boolean {
  const day = new Date(`${dateStr}T12:00:00Z`).getUTCDay(); // 0 Sun … 6 Sat
  return day === 0 || day === 6;
}

// One unit per tracked lead sheet (a "client"). Combined-market sheets are one line.
interface ReportClient {
  clientTag: string;
  name: string;
  bucket: TierBucket;
  leads: Lead[];
}
interface LeadUniverse {
  clients: ReportClient[];
  unmapped: { clientTag: string; name: string }[];   // no tier match
  inactive: number;                                   // resolved but not Active
}

// Read every tracked sheet fresh (so daily counts aren't stale vs the 2-day
// lead-sync cron), then attach each to its tier. Active clients only.
async function buildLeadUniverse(): Promise<LeadUniverse> {
  const [config, tierMap] = await Promise.all([getConfig(), getClientTierMap()]);
  const clients: ReportClient[] = [];
  const unmapped: { clientTag: string; name: string }[] = [];
  let inactive = 0;

  const BATCH = 25;
  for (let i = 0; i < config.sheets.length; i += BATCH) {
    const batch = config.sheets.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map((s) => getLeadsFromSheet(s.id, s.sheetName || "Leads", s.clientTag)),
    );
    for (let j = 0; j < results.length; j++) {
      const s = batch[j];
      const entry = resolveTier(s.clientTag || "", tierMap);
      if (!entry || !entry.bucket) {
        unmapped.push({ clientTag: s.clientTag || "(blank)", name: s.name });
        continue;
      }
      if (!/active/i.test(entry.status)) { inactive++; continue; }
      const leads = results[j].status === "fulfilled" ? (results[j] as PromiseFulfilledResult<Lead[]>).value : [];
      clients.push({ clientTag: s.clientTag, name: s.name, bucket: entry.bucket, leads });
    }
  }
  return { clients, unmapped, inactive };
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// ---------- DAILY ----------
export interface DailyReport { subject: string; text: string; date: string }

export async function buildDailyReport(dateStr: string): Promise<DailyReport> {
  const { clients, unmapped } = await buildLeadUniverse();
  const weekend = isWeekend(dateStr);

  const lines: string[] = [];
  const niceDate = new Date(`${dateStr}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  });
  lines.push(`Daily Meeting-Ready Lead Report — ${niceDate} (PT)`);
  lines.push(weekend ? "(Weekend — targets at 50% of a weekday)" : "");
  lines.push("");

  let grandActual = 0;
  for (const bucket of ["T0.5/1", "T2"] as TierBucket[]) {
    const inBucket = clients.filter((c) => c.bucket === bucket);
    const actual = inBucket.reduce(
      (n, c) => n + c.leads.filter((l) => isMeetingReady(l) && leadDeliveredOn(l, dateStr)).length, 0);
    grandActual += actual;

    const perClientWeekday = TARGETS[bucket].mrMonthly / WEIGHTED_DAYS_PER_MONTH;
    const perClientToday = weekend ? perClientWeekday / 2 : perClientWeekday;
    const target = inBucket.length * perClientToday;

    lines.push(`${BUCKET_LABEL[bucket]}  (${inBucket.length} clients)`);
    lines.push(`  Meeting-ready delivered today: ${actual}`);
    lines.push(`  Target today: ${fmt(target)}   (${actual >= target ? "on/above pace ✅" : "below pace ⚠️"})`);
    lines.push("");
  }
  lines.push(`Total meeting-ready delivered today: ${grandActual}`);
  if (unmapped.length) {
    lines.push("");
    lines.push(`⚠️ ${unmapped.length} client sheet(s) have no tier in the Client Tracker (not counted): ${unmapped.map((u) => u.clientTag).join(", ")}`);
  }

  return { subject: `Daily Lead Report — ${niceDate}`, text: lines.join("\n"), date: dateStr };
}

// ---------- WEEKLY ----------
export interface WeeklyReport { subject: string; text: string; startDate: string; endDate: string; flaggedCount: number }

export async function buildWeeklyReport(endDateStr: string): Promise<WeeklyReport> {
  const { clients, unmapped } = await buildLeadUniverse();

  // 7-day window ending on endDateStr (inclusive).
  const end = new Date(`${endDateStr}T12:00:00Z`);
  const windowDates = new Set<string>();
  for (let i = 0; i < 7; i++) {
    const d = new Date(end.getTime() - i * 86_400_000);
    windowDates.add(pstDateString(d));
  }
  const startDateStr = pstDateString(new Date(end.getTime() - 6 * 86_400_000));

  const deliveredInWindow = (l: Lead): boolean => {
    const raw = l.timeWeGotReply || l.replyTime;
    if (!raw) return false;
    const d = new Date(raw);
    if (isNaN(d.getTime())) return false;
    return windowDates.has(pstDateString(d));
  };

  interface Row { name: string; clientTag: string; bucket: TierBucket; mr: number; ql: number; mrTarget: number; qlTarget: number; flagged: boolean; reasons: string[] }
  const rows: Row[] = [];
  for (const c of clients) {
    const mr = c.leads.filter((l) => isMeetingReady(l) && deliveredInWindow(l)).length;
    const ql = c.leads.filter((l) => isQualityLead(l) && deliveredInWindow(l)).length;
    const mrTarget = TARGETS[c.bucket].mrMonthly * 7 / DAYS_PER_MONTH;
    const qlTarget = TARGETS[c.bucket].qlMonthly * 7 / DAYS_PER_MONTH;
    const reasons: string[] = [];
    if (mr < FLAG_THRESHOLD * mrTarget) reasons.push(`meeting-ready ${mr} vs ${fmt(mrTarget)} target`);
    if (ql < FLAG_THRESHOLD * qlTarget) reasons.push(`QL ${ql} vs ${fmt(qlTarget)} target`);
    rows.push({ name: c.name, clientTag: c.clientTag, bucket: c.bucket, mr, ql, mrTarget, qlTarget, flagged: reasons.length > 0, reasons });
  }

  const flagged = rows.filter((r) => r.flagged).sort((a, b) => a.bucket.localeCompare(b.bucket) || a.clientTag.localeCompare(b.clientTag));

  const lines: string[] = [];
  const range = `${new Date(`${startDateStr}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} – ${new Date(`${endDateStr}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
  lines.push(`Weekly Lead Performance Report — ${range} (PT, last 7 days)`);
  lines.push("");

  // Totals by bucket
  for (const bucket of ["T0.5/1", "T2"] as TierBucket[]) {
    const inB = rows.filter((r) => r.bucket === bucket);
    const mr = inB.reduce((n, r) => n + r.mr, 0);
    const ql = inB.reduce((n, r) => n + r.ql, 0);
    const mrT = inB.reduce((n, r) => n + r.mrTarget, 0);
    const qlT = inB.reduce((n, r) => n + r.qlTarget, 0);
    lines.push(`${BUCKET_LABEL[bucket]}  (${inB.length} clients)`);
    lines.push(`  Meeting-ready: ${mr} (target ${fmt(mrT)})`);
    lines.push(`  Quality leads: ${ql} (target ${fmt(qlT)})`);
    lines.push("");
  }

  lines.push(`── Flagged clients (≥25% behind weekly pace on meeting-ready OR QL): ${flagged.length} ──`);
  if (flagged.length === 0) {
    lines.push("None — all clients on pace this week. 🎉");
  } else {
    for (const r of flagged) {
      lines.push(`• ${r.clientTag} [${BUCKET_LABEL[r.bucket]}] — ${r.reasons.join("; ")}`);
    }
  }
  if (unmapped.length) {
    lines.push("");
    lines.push(`⚠️ ${unmapped.length} client sheet(s) unmapped to a tier (excluded — please add to Client Tracker): ${unmapped.map((u) => u.clientTag).join(", ")}`);
  }

  return { subject: `Weekly Lead Report — ${range}`, text: lines.join("\n"), startDate: startDateStr, endDate: endDateStr, flaggedCount: flagged.length };
}

// ---------- DELIVERY ----------
export async function sendClientReport(payload: { type: "daily" | "weekly"; subject: string; text: string } & Record<string, unknown>): Promise<{ sent: boolean; reason?: string }> {
  const webhookUrl = process.env.N8N_CLIENT_REPORT_WEBHOOK_URL;
  const recipients = (process.env.CLIENT_REPORT_RECIPIENTS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);

  if (!webhookUrl) {
    console.warn("[client-report] N8N_CLIENT_REPORT_WEBHOOK_URL not set — skipping send");
    return { sent: false, reason: "N8N_CLIENT_REPORT_WEBHOOK_URL not configured" };
  }
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, recipients }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`n8n webhook ${res.status}: ${t.slice(0, 300)}`);
  }
  return { sent: true };
}
