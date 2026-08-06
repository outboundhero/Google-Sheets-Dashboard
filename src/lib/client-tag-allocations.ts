import { getSheetsClient } from "@/lib/google-sheets";
import type { BisonGroup } from "@/lib/bison-instances";

/**
 * Client-tag → Bison group allocation.
 *
 * Source of truth is Spencer's client-tag allocation tab, a side-by-side
 * two-group table on gid 239723744 of the main Client Tracker workbook:
 *   - Column A = client tags belonging to Group 1 (B2B#1 + B2C#1)
 *   - Column E = client tags belonging to Group 2 (B2B#2 + B2C#2)
 *   - (B/F = Status, C/G = Churn Date, D/H = Plan — read by other modules,
 *      ignored here; churn is handled in churn-offboarding.ts.)
 *
 * This module reads that sheet and caches the parsed map in Redis. It is
 * completely independent of the per-client tracked-sheets system.
 *
 * NOTE: pinned to the sheet id + gid directly (not via env) — the old
 * CLIENT_TAG_ALLOCATION_SHEET_ID env still points at the retired single-tab
 * sheet, whose 2-column layout has no Group-2 column E.
 */

const ALLOCATION_SHEET_ID = "1MGqSgGNoeN6WgjZnT7_Ij_nZftyyj7Z9DT77rVYLKuQ";

// The allocation table's tab (gid) inside the workbook. Resolved to a title
// at read time so we address it by name for values.batchGet.
const ALLOCATION_TAB_GID = 239723744;

const REDIS_KEY = "client-tag-allocations";

export interface ClientTagAllocations {
  /** UPPERCASE client tag → group (1 or 2). */
  map: Record<string, BisonGroup>;
  syncedAt: string;
  group1Count: number;
  group2Count: number;
}

function getRedis() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const { Redis } = require("@upstash/redis") as typeof import("@upstash/redis");
  return new Redis({ url, token });
}

function normalizeTag(raw: unknown): string {
  return String(raw ?? "").trim().toUpperCase();
}

/** Reads the allocation sheet live and parses columns A + E into a map. */
export async function fetchAllocationsFromSheet(): Promise<ClientTagAllocations> {
  const sheets = await getSheetsClient();

  // Resolve the allocation tab by its gid (sheetId) so a tab rename can't break us.
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: ALLOCATION_SHEET_ID,
    fields: "sheets.properties(sheetId,title)",
  });
  const tab =
    meta.data.sheets?.find((s) => s.properties?.sheetId === ALLOCATION_TAB_GID)
      ?.properties?.title ||
    meta.data.sheets?.[0]?.properties?.title ||
    "Sheet1";

  // Column A = Group 1 client tags, Column E = Group 2 client tags (side-by-side
  // two-group table; B/C/D and F/G/H are Status/Churn Date/Plan for each side).
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: ALLOCATION_SHEET_ID,
    ranges: [`${tab}!A2:A`, `${tab}!E2:E`],
  });

  const group1Col = res.data.valueRanges?.[0]?.values || [];
  const group2Col = res.data.valueRanges?.[1]?.values || [];

  const map: Record<string, BisonGroup> = {};
  let group1Count = 0;
  let group2Count = 0;

  for (const row of group1Col) {
    const tag = normalizeTag(row[0]);
    if (tag) {
      map[tag] = 1;
      group1Count++;
    }
  }
  for (const row of group2Col) {
    const tag = normalizeTag(row[0]);
    if (tag) {
      // A tag should not appear in both columns; Group 2 wins if it does.
      map[tag] = 2;
      group2Count++;
    }
  }

  return {
    map,
    syncedAt: new Date().toISOString(),
    group1Count,
    group2Count,
  };
}

/** Re-reads the allocation sheet and caches the result in Redis. */
export async function syncAllocations(): Promise<ClientTagAllocations> {
  const data = await fetchAllocationsFromSheet();
  const redis = getRedis();
  if (redis) await redis.set(REDIS_KEY, data);
  return data;
}

/** Returns the cached allocation map; syncs once if nothing is cached yet. */
export async function getAllocations(): Promise<ClientTagAllocations> {
  const redis = getRedis();
  if (redis) {
    const cached = await redis.get<ClientTagAllocations>(REDIS_KEY);
    if (cached && cached.map) return cached;
  }
  return syncAllocations();
}

/** Looks up the group for a single client tag. Returns null if unallocated. */
export async function getGroupForClientTag(tag: string): Promise<BisonGroup | null> {
  const { map } = await getAllocations();
  return map[normalizeTag(tag)] ?? null;
}
