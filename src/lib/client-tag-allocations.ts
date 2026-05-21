import { getSheetsClient } from "@/lib/google-sheets";
import type { BisonGroup } from "@/lib/bison-instances";

/**
 * Client-tag → Bison group allocation.
 *
 * Source of truth is ONE Google Sheet maintained by the agency:
 *   - Column A = client tags belonging to Group 1 (B2B#1 + B2C#1)
 *   - Column C = client tags belonging to Group 2 (B2B#2 + B2C#2)
 *   - (Columns B / D are "DONE" checkboxes — ignored.)
 *
 * This module reads that sheet and caches the parsed map in Redis. It is
 * completely independent of the per-client tracked-sheets system.
 */

const ALLOCATION_SHEET_ID =
  process.env.CLIENT_TAG_ALLOCATION_SHEET_ID ||
  "1P-5H4pxB-cRO0i2tp6WjXNN77ibIB4hCnNTuyRzQOYw";

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

/** Reads the allocation sheet live and parses columns A + C into a map. */
export async function fetchAllocationsFromSheet(): Promise<ClientTagAllocations> {
  const sheets = await getSheetsClient();

  // The allocation data lives on the first tab; resolve its name dynamically.
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: ALLOCATION_SHEET_ID,
    fields: "sheets.properties.title",
  });
  const tab = meta.data.sheets?.[0]?.properties?.title || "Sheet1";

  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: ALLOCATION_SHEET_ID,
    ranges: [`${tab}!A2:A`, `${tab}!C2:C`],
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
