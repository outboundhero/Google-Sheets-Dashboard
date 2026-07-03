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

const DAYS_PER_MONTH = 30.44;
// Saturday & Sunday are expected at 10% of a weekday (per Spencer) — deliberately
// low to surface weekends that delivered more than the (minimal) expectation.
const WEEKEND_WEIGHT = 0.1;
// Weighted days in a month: each weekday counts 1, each weekend day WEEKEND_WEIGHT.
// 30.44 × (5 + 2×0.1)/7 ≈ 22.6 — used to derive the weekday daily target.
const WEIGHTED_DAYS_PER_MONTH = (DAYS_PER_MONTH * (5 + 2 * WEEKEND_WEIGHT)) / 7;
const FLAG_THRESHOLD = 0.75; // flagged when actual < 75% of pace (i.e. ≥25% behind)

// Monthly targets per tier (per user, 2026-07):
//   Tier 0.5 → 15 MRLs /  5 QLs
//   Tier 1   → 20 MRLs / 10 QLs
//   Tier 2   → 40 MRLs / 20 QLs
export type TierBucket = "T0.5" | "T1" | "T2";
export const TARGETS: Record<TierBucket, { mrMonthly: number; qlMonthly: number }> = {
  "T0.5": { mrMonthly: 15, qlMonthly: 5 },
  "T1": { mrMonthly: 20, qlMonthly: 10 },
  "T2": { mrMonthly: 40, qlMonthly: 20 },
};
const BUCKET_LABEL: Record<TierBucket, string> = {
  "T0.5": "Tier 0.5",
  "T1": "Tier 1",
  "T2": "Tier 2",
};

function tierBucketFromPlan(plan: string): TierBucket | null {
  const p = plan.toLowerCase();
  if (p.includes("tier 0.5")) return "T0.5";
  if (p.includes("tier 1")) return "T1";
  if (p.includes("tier 2")) return "T2";
  return null; // PPQM / PPQL / blank → not a tiered client
}

export interface TrackerEntry { plan: string; status: string; bucket: TierBucket | null }

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
    const abbrCell = String(r[abbrI] || "").trim();
    if (!abbrCell) continue;
    const plan = String(r[planI] || "").trim();
    const entry: TrackerEntry = { plan, status: String(r[statusI] || "").trim(), bucket: tierBucketFromPlan(plan) };
    // Register the whole cell AND each individual market abbreviation, so a
    // combined tracker client like "DBSM & DBSA & DBSF" or "JPCHI & JPCIN"
    // also matches a lead sheet tagged "DBSM / DBSA / …" or "JPCIN / JPCHI".
    const keys = new Set<string>([abbrCell.toUpperCase()]);
    for (const slash of abbrCell.split("/")) {
      for (const amp of slash.split(" & ")) {
        const v = amp.trim().toUpperCase();
        if (v) keys.add(v);
      }
    }
    for (const k of keys) {
      // First registration wins (explicit standalone rows beat a split part) —
      // EXCEPT a tracker can hold duplicate rows for one abbreviation where the
      // first has a blank Plan (e.g. two "JPC&A" rows, one blank + one "Tier 1").
      // A later row that actually has a tier must override the blank one,
      // otherwise the client resolves to no bucket and silently goes unmapped.
      const existing = map.get(k);
      if (!existing || (existing.bucket === null && entry.bucket !== null)) {
        map.set(k, entry);
      }
    }
  }
  return map;
}

// Resolve a lead-sheet clientTag to its tracker entry. Tags can be combined
// markets ("JPCIN / JPCHI", "DBSM/DBSA", "TM & VC") — try the whole tag first,
// then each part split on "/" and " & " (the codebase keeps "&"-without-spaces
// abbreviations like K&LCS / TM&VC intact).
export function resolveTier(clientTag: string, map: Map<string, TrackerEntry>): TrackerEntry | null {
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
  failedSheets: string[];                             // could not be read (excluded — run is incomplete)
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Read one sheet with retries. Returns null only if every attempt failed —
// callers MUST treat null as "unknown", never as "zero leads", otherwise a
// transient read failure would silently undercount and mis-flag a client.
async function readSheetWithRetry(
  s: { id: string; sheetName?: string; clientTag: string },
  retries = 4,
): Promise<Lead[] | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await getLeadsFromSheet(s.id, s.sheetName || "Leads", s.clientTag);
    } catch (err) {
      if (attempt === retries) return null;
      const msg = err instanceof Error ? err.message : String(err);
      const quota =
        (err as { code?: number })?.code === 429 ||
        /quota|rate.?limit|RESOURCE_EXHAUSTED|\b429\b/i.test(msg);
      // Google's read quota is enforced per ROLLING MINUTE — a short backoff
      // lands in the same throttled window and fails again (this was why ~25
      // sheets dropped each run). Wait out the window on quota errors.
      await sleep(quota ? 20_000 + attempt * 10_000 : 1_200 * (attempt + 1));
    }
  }
  return null;
}

// Read every tracked sheet fresh (so daily counts aren't stale vs the 2-day
// lead-sync cron), then attach each to its tier. Active clients only.
async function buildLeadUniverse(): Promise<LeadUniverse> {
  const [config, tierMap] = await Promise.all([getConfig(), getClientTierMap()]);
  const clients: ReportClient[] = [];
  const unmapped: { clientTag: string; name: string }[] = [];
  const failedSheets: string[] = [];
  let inactive = 0;

  // Google Sheets read quota is ~per-minute, so reading ~100 separate
  // spreadsheets in fast 20-wide bursts (the old BATCH=20 + 400ms) saturated it
  // and ~25 sheets 429'd every run. We have a 300s cron budget (maxDuration),
  // so read in small bursts paced to a sustained rate well under quota.
  const READS_PER_MIN = 50;
  const BATCH = 5;
  const BATCH_INTERVAL_MS = Math.ceil((BATCH / READS_PER_MIN) * 60_000); // ~6s per 5 reads
  for (let i = 0; i < config.sheets.length; i += BATCH) {
    const batch = config.sheets.slice(i, i + BATCH);
    const results = await Promise.all(batch.map((s) => readSheetWithRetry(s)));
    for (let j = 0; j < results.length; j++) {
      const s = batch[j];
      const entry = resolveTier(s.clientTag || "", tierMap);
      if (!entry || !entry.bucket) {
        unmapped.push({ clientTag: s.clientTag || "(blank)", name: s.name });
        continue;
      }
      if (!/active/i.test(entry.status)) { inactive++; continue; }
      const leads = results[j];
      if (leads === null) {
        // Read failed after retries — exclude rather than count as 0, and flag the run.
        failedSheets.push(s.clientTag || s.name);
        continue;
      }
      clients.push({ clientTag: s.clientTag, name: s.name, bucket: entry.bucket, leads });
    }
    if (i + BATCH < config.sheets.length) await sleep(BATCH_INTERVAL_MS);
  }
  return { clients, unmapped, inactive, failedSheets };
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// ---------- HTML helpers (inline styles — email-client safe) ----------
const BRAND = "#4f46e5";
function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function htmlShell(title: string, subtitle: string, inner: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7;">
  <div style="max-width:640px;margin:0 auto;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
      <div style="background:${BRAND};padding:20px 24px;">
        <div style="color:#ffffff;font-size:18px;font-weight:700;">${esc(title)}</div>
        <div style="color:#c7d2fe;font-size:13px;margin-top:3px;">${esc(subtitle)}</div>
      </div>
      <div style="padding:20px 24px;">${inner}</div>
    </div>
    <div style="color:#9ca3af;font-size:11px;text-align:center;margin-top:14px;">Automated report · OutboundHero</div>
  </div></body></html>`;
}
function pill(text: string, ok: boolean): string {
  const bg = ok ? "#dcfce7" : "#fee2e2", fg = ok ? "#166534" : "#991b1b";
  return `<span style="display:inline-block;padding:2px 9px;border-radius:999px;background:${bg};color:${fg};font-size:11px;font-weight:600;">${esc(text)}</span>`;
}
function callout(text: string): string {
  return `<div style="margin-top:16px;padding:10px 12px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;color:#92400e;font-size:12px;line-height:1.5;">⚠️ ${esc(text)}</div>`;
}
function calloutRed(text: string): string {
  return `<div style="margin-top:16px;padding:10px 12px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;color:#991b1b;font-size:12px;line-height:1.5;font-weight:600;">‼️ ${esc(text)}</div>`;
}

// ---------- DAILY ----------
export interface DailyReport { subject: string; text: string; html: string; date: string }

export async function buildDailyReport(dateStr: string): Promise<DailyReport> {
  const { clients, unmapped, failedSheets } = await buildLeadUniverse();
  const weekend = isWeekend(dateStr);
  const niceDate = new Date(`${dateStr}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  });

  const buckets = (["T0.5", "T1", "T2"] as TierBucket[]).map((bucket) => {
    const inBucket = clients.filter((c) => c.bucket === bucket);
    const actual = inBucket.reduce(
      (n, c) => n + c.leads.filter((l) => isMeetingReady(l) && leadDeliveredOn(l, dateStr)).length, 0);
    const perWeekday = TARGETS[bucket].mrMonthly / WEIGHTED_DAYS_PER_MONTH;
    const target = inBucket.length * (weekend ? perWeekday * WEEKEND_WEIGHT : perWeekday);
    return { label: BUCKET_LABEL[bucket], count: inBucket.length, actual, target, onPace: actual >= target };
  });
  const grandActual = buckets.reduce((n, b) => n + b.actual, 0);

  // Plain-text body
  const lines: string[] = [];
  lines.push(`Daily Meeting-Ready Lead Report — ${niceDate} (PST)`);
  if (weekend) lines.push("(Weekend — targets at 10% of a weekday)");
  lines.push("");
  for (const b of buckets) {
    lines.push(`${b.label}  (${b.count} clients)`);
    lines.push(`  Meeting-ready delivered today: ${b.actual}`);
    lines.push(`  Target today: ${fmt(b.target)}   (${b.onPace ? "on/above pace ✅" : "below pace ⚠️"})`);
    lines.push("");
  }
  lines.push(`Total meeting-ready delivered today: ${grandActual}`);
  if (failedSheets.length) {
    lines.push("");
    lines.push(`‼️ ${failedSheets.length} sheet(s) could not be read this run — totals may be INCOMPLETE: ${failedSheets.join(", ")}`);
  }
  if (unmapped.length) {
    lines.push("");
    lines.push(`⚠️ ${unmapped.length} client sheet(s) have no tier in the Client Tracker (not counted): ${unmapped.map((u) => u.clientTag).join(", ")}`);
  }

  // HTML body
  const cards = buckets.map((b) => `
    <div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin-bottom:12px;">
      <div style="font-size:13px;color:#6b7280;font-weight:600;">${esc(b.label)} <span style="color:#9ca3af;font-weight:400;">· ${b.count} clients</span></div>
      <table width="100%" style="margin-top:6px;"><tr>
        <td style="vertical-align:bottom;"><span style="font-size:28px;font-weight:700;color:#111827;">${b.actual}</span> <span style="font-size:13px;color:#6b7280;">delivered today</span></td>
        <td style="text-align:right;vertical-align:bottom;font-size:12px;color:#6b7280;">target ${fmt(b.target)}<br/>${pill(b.onPace ? "on pace" : "below pace", b.onPace)}</td>
      </tr></table>
    </div>`).join("");
  const totalHtml = `<div style="margin-top:4px;padding-top:12px;border-top:1px solid #e5e7eb;font-size:15px;"><b>Total meeting-ready delivered today:</b> ${grandActual}</div>`;
  const failedHtml = failedSheets.length ? calloutRed(`${failedSheets.length} sheet(s) could not be read this run — totals may be incomplete: ${failedSheets.join(", ")}`) : "";
  const unmappedHtml = unmapped.length ? callout(`${unmapped.length} client sheet(s) have no tier in the Client Tracker (not counted): ${unmapped.map((u) => u.clientTag).join(", ")}`) : "";
  const html = htmlShell("Daily Meeting-Ready Lead Report", `${niceDate} (PST)${weekend ? " · weekend targets at 10%" : ""}`, cards + totalHtml + failedHtml + unmappedHtml);

  return { subject: `Daily Lead Report — ${niceDate}`, text: lines.join("\n"), html, date: dateStr };
}

// ---------- WEEKLY ----------
export interface WeeklyReport { subject: string; text: string; html: string; startDate: string; endDate: string; flaggedCount: number }

export async function buildWeeklyReport(endDateStr: string): Promise<WeeklyReport> {
  const { clients, unmapped, failedSheets } = await buildLeadUniverse();

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
  lines.push(`Weekly Lead Performance Report — ${range} (PST, last 7 days)`);
  lines.push("");

  // Totals by bucket
  const bucketTotals = (["T0.5/1", "T2"] as TierBucket[]).map((bucket) => {
    const inB = rows.filter((r) => r.bucket === bucket);
    return {
      label: BUCKET_LABEL[bucket], count: inB.length,
      mr: inB.reduce((n, r) => n + r.mr, 0), ql: inB.reduce((n, r) => n + r.ql, 0),
      mrT: inB.reduce((n, r) => n + r.mrTarget, 0), qlT: inB.reduce((n, r) => n + r.qlTarget, 0),
    };
  });
  for (const b of bucketTotals) {
    lines.push(`${b.label}  (${b.count} clients)`);
    lines.push(`  Meeting-ready: ${b.mr} (target ${fmt(b.mrT)})`);
    lines.push(`  Quality leads: ${b.ql} (target ${fmt(b.qlT)})`);
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
  if (failedSheets.length) {
    lines.push("");
    lines.push(`‼️ ${failedSheets.length} sheet(s) could not be read this run — totals may be INCOMPLETE: ${failedSheets.join(", ")}`);
  }
  if (unmapped.length) {
    lines.push("");
    lines.push(`⚠️ ${unmapped.length} client sheet(s) unmapped to a tier (excluded — please add to Client Tracker): ${unmapped.map((u) => u.clientTag).join(", ")}`);
  }

  // HTML body
  const summaryCards = bucketTotals.map((b) => `
    <div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin-bottom:12px;">
      <div style="font-size:13px;color:#6b7280;font-weight:600;">${esc(b.label)} <span style="color:#9ca3af;font-weight:400;">· ${b.count} clients</span></div>
      <table width="100%" style="margin-top:8px;font-size:14px;">
        <tr><td>Meeting-ready</td><td style="text-align:right;"><b>${b.mr}</b> <span style="color:#9ca3af;">/ ${fmt(b.mrT)}</span></td></tr>
        <tr><td style="padding-top:2px;">Quality leads</td><td style="padding-top:2px;text-align:right;"><b>${b.ql}</b> <span style="color:#9ca3af;">/ ${fmt(b.qlT)}</span></td></tr>
      </table>
    </div>`).join("");

  const cellHtml = (act: number, t: number, behind: boolean) =>
    `<span style="color:${behind ? "#dc2626" : "#111827"};font-weight:${behind ? 700 : 400};">${act}</span> <span style="color:#9ca3af;">/ ${fmt(t)}</span>`;
  const flaggedHtml = flagged.length === 0
    ? `<div style="padding:12px;background:#dcfce7;border-radius:8px;color:#166534;font-size:14px;">All clients on pace this week 🎉</div>`
    : `<table width="100%" style="border-collapse:collapse;font-size:13px;">
        <thead><tr style="color:#6b7280;border-bottom:2px solid #e5e7eb;">
          <th style="padding:6px 8px;text-align:left;">Client</th>
          <th style="padding:6px 8px;text-align:left;">Tier</th>
          <th style="padding:6px 8px;text-align:right;">Meeting-ready</th>
          <th style="padding:6px 8px;text-align:right;">Quality leads</th>
        </tr></thead><tbody>
        ${flagged.map((r, i) => `<tr style="border-bottom:1px solid #f3f4f6;background:${i % 2 ? "#fafafa" : "#ffffff"};">
          <td style="padding:6px 8px;font-weight:600;">${esc(r.clientTag)}</td>
          <td style="padding:6px 8px;color:#6b7280;">${esc(BUCKET_LABEL[r.bucket])}</td>
          <td style="padding:6px 8px;text-align:right;">${cellHtml(r.mr, r.mrTarget, r.mr < FLAG_THRESHOLD * r.mrTarget)}</td>
          <td style="padding:6px 8px;text-align:right;">${cellHtml(r.ql, r.qlTarget, r.ql < FLAG_THRESHOLD * r.qlTarget)}</td>
        </tr>`).join("")}
        </tbody></table>`;
  const flaggedHeader = `<div style="font-size:15px;font-weight:700;margin:18px 0 8px;">Flagged clients <span style="color:#dc2626;">(${flagged.length})</span><div style="font-weight:400;color:#9ca3af;font-size:12px;margin-top:2px;">≥25% behind weekly pace on meeting-ready or quality leads</div></div>`;
  const failedHtml = failedSheets.length ? calloutRed(`${failedSheets.length} sheet(s) could not be read this run — totals may be incomplete: ${failedSheets.join(", ")}`) : "";
  const unmappedHtml = unmapped.length ? callout(`${unmapped.length} client sheet(s) unmapped to a tier (excluded — please add to Client Tracker): ${unmapped.map((u) => u.clientTag).join(", ")}`) : "";
  const html = htmlShell("Weekly Lead Performance Report", `${range} (PST) · last 7 days`, summaryCards + flaggedHeader + flaggedHtml + failedHtml + unmappedHtml);

  return { subject: `Weekly Lead Report — ${range}`, text: lines.join("\n"), html, startDate: startDateStr, endDate: endDateStr, flaggedCount: flagged.length };
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
