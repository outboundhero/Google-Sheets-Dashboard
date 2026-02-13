import { google, sheets_v4 } from "googleapis";
import type { Lead, LeadStatus } from "@/types/lead";
import { cache } from "./cache";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"];

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

async function getSheetData(spreadsheetId: string, sheetName: string): Promise<SheetData> {
  const cacheKey = `sheet-data:${spreadsheetId}:${sheetName}`;
  const cached = cache.get<SheetData>(cacheKey);
  if (cached) return cached;

  const sheets = await getSheetsClient();

  // Fetch header row + all data rows
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A1:AZ`,
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
  sheetName: string
): Lead {
  const get = (field: string) => {
    const idx = columnMap[field];
    return idx !== undefined ? (row[idx] || "") : "";
  };

  return {
    email: get("email"),
    name: get("name"),
    company: get("company"),
    timeWeGotReply: get("timeWeGotReply"),
    replyTime: get("replyTime"),
    city: get("city"),
    address: get("address"),
    googleMapsUrl: get("googleMapsUrl"),
    state: get("state"),
    phone: get("phone"),
    currentCategory: get("currentCategory"),
    clientTag: get("clientTag"),
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
  sheetName: string
): Promise<Lead[]> {
  const { headers, rows } = await getSheetData(spreadsheetId, sheetName);
  const columnMap = buildColumnMap(headers);
  return rows
    .map((row) => mapRowToLead(row, columnMap, spreadsheetId, sheetName))
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
  sheets: { id: string; name: string; sheetName: string }[]
): Promise<Lead[]> {
  const cacheKey = "all-leads";
  const cached = cache.get<Lead[]>(cacheKey);
  if (cached) return cached;

  // Fetch in batches of 10 to respect rate limits
  const batchSize = 10;
  const allLeads: Lead[] = [];

  for (let i = 0; i < sheets.length; i += batchSize) {
    const batch = sheets.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map((s) => getLeadsFromSheet(s.id, s.sheetName))
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        allLeads.push(...result.value);
      }
    }
  }

  cache.set(cacheKey, allLeads);
  return allLeads;
}
