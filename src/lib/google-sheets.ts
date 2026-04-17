import { google, sheets_v4 } from "googleapis";
import type { Lead, LeadStatus } from "@/types/lead";
import { cache } from "./cache";

// Client Tracker spreadsheet (internal Outboundhero sheet with churn/pause/go-live dates)
const CLIENT_TRACKER_SHEET_ID = "1MGqSgGNoeN6WgjZnT7_Ij_nZftyyj7Z9DT77rVYLKuQ";
const CLIENT_TRACKER_TAB = "Client Tracker";

export interface ClientTrackerRow {
  companyName: string;
  clientAbbr: string;
  status: string;
  startDate: string | null;
  goLiveDate: string | null;
  churnDate: string | null;
  pauseDate: string | null;
}

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

let sheetsClient: sheets_v4.Sheets | null = null;

async function getSheetsClient(): Promise<sheets_v4.Sheets> {
  if (sheetsClient) return sheetsClient;

  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    scopes: SCOPES,
  });

  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

export async function getSheetMetadata(
  spreadsheetId: string
): Promise<{ title: string; sheetNames: string[] }> {
  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "properties.title,sheets.properties",
  });
  return {
    title: response.data.properties?.title || "Unknown",
    sheetNames:
      response.data.sheets?.map((s) => s.properties?.title || "") || [],
  };
}

// Map from header names (lowercase) to Lead field names
const HEADER_TO_FIELD: Record<string, keyof Lead> = {
  "lead email": "email",
  "lead name": "name",
  "company name": "company",
  "company": "company",
  "time we got reply": "timeWeGotReply",
  "reply time": "replyTime",
  "city": "city",
  "state": "state",
  "address": "address",
  "google maps url": "googleMapsUrl",
  "google maps": "googleMapsUrl",
  "phone": "phone",
  "current lead category": "currentCategory",
  "current category": "currentCategory",
  "category": "currentCategory",
  "client tag": "clientTag",
  "client": "clientTag",
  "client name": "clientTag",
  "sender email": "senderEmail",
  "reply we got": "replyContent",
  "prospect cc email": "prospectCcEmail",
  "our last reply": "ourLastReply",
  "cc email 1": "ccEmail1",
  "cc email 2": "ccEmail2",
  "duplicate check": "duplicateCheck",
  "status (required)": "status",
  "status": "status",
  "notes (required)": "notes",
  "notes": "notes",
  "# of attempts c&e": "attemptCount",
  "# of attempts": "attemptCount",
  "quality lead criteria in agreement": "qualityLeadCriteria",
  "quality lead criteria": "qualityLeadCriteria",
};

interface SheetData {
  headers: string[];
  rows: string[][];
}

// Normalize any Google Sheets date string to ISO 8601.
// Google Sheets returns dates in various locale-dependent formats depending on
// the spreadsheet's region settings (e.g. "3/9/2026 2:30:00 PM", "09/03/2026",
// "27/02/2026"). Node.js cannot parse AM/PM or DD/MM formats reliably, so we
// convert to ISO here at ingest time so analytics always has a clean value.
function normalizeGoogleDate(raw: string): string {
  if (!raw) return "";

  // 1. Standard JS parsing (handles ISO, "3/9/2026", "3/9/2026 14:30:00", etc.)
  let d = new Date(raw);
  if (!isNaN(d.getTime())) return d.toISOString();

  // 2. "M/D/YYYY h:mm:ss AM/PM" or "M/D/YYYY h:mm AM/PM"
  const amPm = raw.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i
  );
  if (amPm) {
    const [, month, day, year, hStr, min, sec, meridiem] = amPm;
    let h = parseInt(hStr, 10);
    if (meridiem.toUpperCase() === "PM" && h !== 12) h += 12;
    if (meridiem.toUpperCase() === "AM" && h === 12) h = 0;
    d = new Date(
      `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${String(h).padStart(2, "0")}:${min}:${sec ?? "00"}`
    );
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  // 3. DD/MM/YYYY or DD/MM/YYYY HH:MM:SS where day > 12 (standard parsing fails
  //    because it treats the first number as month, which > 12 is invalid).
  const ddmm = raw.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (ddmm) {
    const [, p1, p2, year, hour, min, sec] = ddmm;
    if (parseInt(p1, 10) > 12 && parseInt(p2, 10) <= 12) {
      const time = hour
        ? `T${hour.padStart(2, "0")}:${min}:${sec ?? "00"}`
        : "T00:00:00";
      d = new Date(`${year}-${p2.padStart(2, "0")}-${p1.padStart(2, "0")}${time}`);
      if (!isNaN(d.getTime())) return d.toISOString();
    }
  }

  return raw; // Return original if nothing matched — analytics will skip it gracefully
}

// Escape sheet names for Google Sheets A1 notation
// Names with special characters must be wrapped in single quotes
function escapeSheetName(name: string): string {
  if (/[^a-zA-Z0-9_]/.test(name)) {
    return `'${name.replace(/'/g, "''")}'`;
  }
  return name;
}

async function getSheetData(spreadsheetId: string, sheetName: string): Promise<SheetData> {
  const cacheKey = `sheet-data:${spreadsheetId}:${sheetName}`;
  const cached = cache.get<SheetData>(cacheKey);
  if (cached) return cached;

  const sheets = await getSheetsClient();

  // Fetch header row + all data rows
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${escapeSheetName(sheetName)}!A1:AZ`,
  });

  const allRows = response.data.values || [];
  const headers = allRows[0] || [];
  const rows = allRows.slice(1);

  const result: SheetData = { headers, rows };
  cache.set(cacheKey, result);
  return result;
}

function buildColumnMap(headers: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (let i = 0; i < headers.length; i++) {
    const headerLower = headers[i].trim().toLowerCase();
    const field = HEADER_TO_FIELD[headerLower];
    if (field) {
      // Only use first match (don't overwrite if duplicate headers)
      if (!(field in map)) {
        map[field] = i;
      }
    }
  }
  return map;
}

function mapRowToLead(
  row: string[],
  columnMap: Record<string, number>,
  sheetId: string,
  sheetName: string,
  sheetClientTag?: string
): Lead {
  const get = (field: string) => {
    const idx = columnMap[field];
    return idx !== undefined ? (row[idx] || "") : "";
  };

  // Keep original client tag from spreadsheet
  const originalClientTag = get("clientTag");

  // Use sheet's client tag for grouping, or fall back to original
  const groupingClientTag = sheetClientTag || originalClientTag;

  return {
    email: get("email"),
    name: get("name"),
    company: get("company"),
    timeWeGotReply: normalizeGoogleDate(get("timeWeGotReply")),
    replyTime: normalizeGoogleDate(get("replyTime")),
    city: get("city"),
    address: get("address"),
    googleMapsUrl: get("googleMapsUrl"),
    state: get("state"),
    phone: get("phone"),
    currentCategory: get("currentCategory"),
    clientTag: originalClientTag, // Original from spreadsheet (for display)
    sheetClientTag: groupingClientTag, // From config (for grouping)
    senderEmail: get("senderEmail"),
    replyContent: get("replyContent"),
    prospectCcEmail: get("prospectCcEmail"),
    ourLastReply: get("ourLastReply"),
    ccEmail1: get("ccEmail1"),
    ccEmail2: get("ccEmail2"),
    duplicateCheck: get("duplicateCheck"),
    status: get("status") as LeadStatus,
    notes: get("notes"),
    attemptCount: get("attemptCount"),
    qualityLeadCriteria: get("qualityLeadCriteria"),
    sheetId,
    sheetName,
  };
}

export async function getLeadsFromSheet(
  spreadsheetId: string,
  sheetName: string,
  sheetClientTag?: string
): Promise<Lead[]> {
  const { headers, rows } = await getSheetData(spreadsheetId, sheetName);
  const columnMap = buildColumnMap(headers);

  return rows
    .map((row) => mapRowToLead(row, columnMap, spreadsheetId, sheetName, sheetClientTag))
    .filter((lead) => {
      // Must have valid email
      if (!lead.email || !lead.email.includes("@")) return false;

      // Filter by duplicate check - only show "New" or empty/missing
      const dupCheck = (lead.duplicateCheck || "").trim().toLowerCase();
      // If duplicate check exists and is NOT "new", exclude it
      if (dupCheck && dupCheck !== "new") return false;

      return true;
    });
}

export async function getAllLeads(
  sheets: { id: string; name: string; sheetName?: string; clientTag: string }[]
): Promise<Lead[]> {
  const cacheKey = "all-leads";
  const cached = cache.get<Lead[]>(cacheKey);
  if (cached) return cached;

  // Fetch in batches — larger batches complete faster on Vercel
  // Google Sheets API allows 300 req/min per project, so 25 concurrent is safe
  const batchSize = 25;
  const allLeads: Lead[] = [];

  for (let i = 0; i < sheets.length; i += batchSize) {
    const batch = sheets.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map((s) => getLeadsFromSheet(s.id, s.sheetName || "Leads", s.clientTag))
    );
    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const sheetInfo = batch[j];
      if (result.status === "fulfilled") {
        allLeads.push(...result.value);
      } else {
        console.error(
          `[getAllLeads] Failed to fetch sheet "${sheetInfo.name}" (id: ${sheetInfo.id}, tab: ${sheetInfo.sheetName || "Leads"}, client: ${sheetInfo.clientTag}):`,
          result.reason
        );
      }
    }
  }

  cache.set(cacheKey, allLeads);
  return allLeads;
}

export async function getClientTrackerData(): Promise<ClientTrackerRow[]> {
  const cacheKey = "client-tracker-data";
  const cached = cache.get<ClientTrackerRow[]>(cacheKey);
  if (cached) return cached;

  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: CLIENT_TRACKER_SHEET_ID,
    range: `'${CLIENT_TRACKER_TAB}'!A1:T`,
    valueRenderOption: "FORMATTED_VALUE",
  });

  const allRows = response.data.values || [];
  if (allRows.length < 2) return [];

  const headers = allRows[0].map((h: string) => String(h).toLowerCase().trim());
  const idx = (name: string) => headers.findIndex((h: string) => h.includes(name));

  const companyIdx = idx("company name");
  const abbrIdx = idx("client abbr");
  const statusIdx = headers.findIndex((h: string) => h === "status");
  const startDateIdx = idx("start date");
  const goLiveIdx = idx("go live date");
  const churnIdx = idx("churn date");
  const pauseIdx = idx("pause date");

  const result: ClientTrackerRow[] = allRows
    .slice(1)
    .map((row: string[]) => ({
      companyName: row[companyIdx] || "",
      clientAbbr: row[abbrIdx] || "",
      status: statusIdx >= 0 ? (row[statusIdx] || "") : "",
      startDate: startDateIdx >= 0 ? (row[startDateIdx] || null) : null,
      goLiveDate: goLiveIdx >= 0 ? (row[goLiveIdx] || null) : null,
      churnDate: churnIdx >= 0 ? (row[churnIdx] || null) : null,
      pauseDate: pauseIdx >= 0 ? (row[pauseIdx] || null) : null,
    }))
    .filter((r: ClientTrackerRow) => r.clientAbbr.trim() !== "");

  cache.set(cacheKey, result);
  return result;
}

/**
 * Fetch all client tags from both "Client Tracker" (Client Abbreviation) and "Sheet6" (Client Tag).
 * Returns a deduplicated array of tag strings.
 */
export async function getAllClientTags(): Promise<string[]> {
  const cacheKey = "all-client-tags";
  const cached = cache.get<string[]>(cacheKey);
  if (cached) return cached;

  const sheets = await getSheetsClient();

  const [trackerRes, sheet6Res] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: CLIENT_TRACKER_SHEET_ID,
      range: `'${CLIENT_TRACKER_TAB}'!A1:T`,
      valueRenderOption: "FORMATTED_VALUE",
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: CLIENT_TRACKER_SHEET_ID,
      range: "'Sheet6'!A1:A",
      valueRenderOption: "FORMATTED_VALUE",
    }),
  ]);

  const tags = new Set<string>();

  // Split "DBSM & DBSA & DBSF" into individual tags (space-delimited &)
  // but keep "TM&VC", "JPC&A", "K&LCS" intact (no spaces around &)
  const addCell = (cell: string) => {
    for (const part of cell.split(" & ")) {
      const v = part.trim();
      if (v) tags.add(v);
    }
  };

  // Extract from Client Tracker tab (Client Abbreviation column)
  const trackerRows = trackerRes.data.values || [];
  if (trackerRows.length >= 2) {
    const headers = trackerRows[0].map((h: string) => String(h).toLowerCase().trim());
    const abbrIdx = headers.findIndex((h: string) => h.includes("client abbr"));
    if (abbrIdx >= 0) {
      for (const row of trackerRows.slice(1)) {
        const val = (row[abbrIdx] || "").trim();
        if (val) addCell(val);
      }
    }
  }

  // Extract from Sheet6 (Client Tag column A)
  const sheet6Rows = sheet6Res.data.values || [];
  for (const row of sheet6Rows.slice(1)) {
    const val = (row[0] || "").trim();
    if (val) addCell(val);
  }

  const result = Array.from(tags).sort();
  cache.set(cacheKey, result);
  return result;
}

/**
 * Append domains to a spreadsheet's "Domains" tab.
 * Deduplicates against existing domains in column B.
 * Writes: [Date Added, Domain, "FALSE", "New"] per row.
 */
export async function appendDomainsToSheet(
  spreadsheetId: string,
  domains: string[]
): Promise<{ added: number; duplicates: number }> {
  const sheets = await getSheetsClient();
  const sheetName = "Domains";
  const escaped = escapeSheetName(sheetName);

  // Read existing domains from column B (skip header rows 1-2)
  const existingRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${escaped}!B3:B`,
  });
  const existingDomains = new Set(
    (existingRes.data.values || []).map((row) => (row[0] || "").trim().toLowerCase())
  );

  // Filter out duplicates
  const newDomains = domains.filter(
    (d) => !existingDomains.has(d.trim().toLowerCase())
  );
  const duplicates = domains.length - newDomains.length;

  if (newDomains.length === 0) {
    return { added: 0, duplicates };
  }

  // Format date as M/D/YYYY (no leading zeros)
  const now = new Date();
  const dateStr = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;

  // Build rows: [Date Added, Domain, Whitelisted?, Duplicate Check]
  const rows = newDomains.map((domain) => [dateStr, domain, "FALSE", "New"]);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${escaped}!A:D`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });

  return { added: newDomains.length, duplicates };
}
