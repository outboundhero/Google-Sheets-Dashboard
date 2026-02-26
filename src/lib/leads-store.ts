import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { Lead } from "@/types/lead";

const STORE_PATH = join(process.cwd(), "leads-store.json");
const REDIS_KEY_PREFIX = "leads-store";
const META_KEY = `${REDIS_KEY_PREFIX}:meta`;
const SHEET_KEY_PREFIX = `${REDIS_KEY_PREFIX}:sheet`;
const STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours

export interface SyncMetadata {
  lastSyncAt: string | null;
  syncInProgress: boolean;
  syncStartedAt: string | null;
  totalLeads: number;
  sheetsSuccess: number;
  sheetsError: number;
  sheetKeys: string[]; // Redis keys for all stored sheets
  errors?: { sheetId: string; name: string; error: string }[];
}

export interface StoredSheetData {
  sheetId: string;
  clientTag: string;
  sheetName: string;
  syncedAt: string;
  leads: Lead[];
}

interface LocalStore {
  meta: SyncMetadata;
  sheets: Record<string, StoredSheetData>;
}

const DEFAULT_META: SyncMetadata = {
  lastSyncAt: null,
  syncInProgress: false,
  syncStartedAt: null,
  totalLeads: 0,
  sheetsSuccess: 0,
  sheetsError: 0,
  sheetKeys: [],
};

// --- Redis client (same pattern as sheets-config.ts) ---

function getRedis() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const { Redis } = require("@upstash/redis") as typeof import("@upstash/redis");
  return new Redis({ url, token });
}

// --- Local file storage (dev fallback) ---

function getLocalStore(): LocalStore {
  try {
    const raw = readFileSync(STORE_PATH, "utf-8");
    return JSON.parse(raw) as LocalStore;
  } catch {
    return { meta: { ...DEFAULT_META }, sheets: {} };
  }
}

function saveLocalStore(store: LocalStore): void {
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

// --- Trim large fields to save storage ---

export function trimLeadForStorage(lead: Lead): Lead {
  return {
    ...lead,
    replyContent: "",
    ourLastReply: "",
  };
}

// --- Read operations ---

export async function getSyncMetadata(): Promise<SyncMetadata> {
  const redis = getRedis();
  if (redis) {
    const meta = await redis.get<SyncMetadata>(META_KEY);
    return meta || { ...DEFAULT_META };
  }
  return getLocalStore().meta;
}

export function isSyncStale(meta: SyncMetadata): boolean {
  if (!meta.lastSyncAt) return true;
  const elapsed = Date.now() - new Date(meta.lastSyncAt).getTime();
  return elapsed > STALE_THRESHOLD_MS;
}

export async function getStoredLeads(): Promise<Lead[]> {
  const redis = getRedis();
  if (redis) {
    const meta = await redis.get<SyncMetadata>(META_KEY);
    if (!meta || meta.sheetKeys.length === 0) return [];

    // Fetch all sheet data in one pipeline
    const pipeline = redis.pipeline();
    for (const key of meta.sheetKeys) {
      pipeline.get(key);
    }
    const results = await pipeline.exec<(StoredSheetData | null)[]>();

    const allLeads: Lead[] = [];
    for (const data of results) {
      if (data && data.leads) {
        allLeads.push(...data.leads);
      }
    }
    return allLeads;
  }

  // Local fallback
  const store = getLocalStore();
  const allLeads: Lead[] = [];
  for (const data of Object.values(store.sheets)) {
    allLeads.push(...data.leads);
  }
  return allLeads;
}

export async function getStoredSheetLeads(sheetId: string): Promise<Lead[]> {
  const redis = getRedis();
  if (redis) {
    const data = await redis.get<StoredSheetData>(`${SHEET_KEY_PREFIX}:${sheetId}`);
    return data?.leads || [];
  }
  const store = getLocalStore();
  return store.sheets[sheetId]?.leads || [];
}

// --- Write operations ---

export async function storeSyncMetadata(meta: SyncMetadata): Promise<void> {
  const redis = getRedis();
  if (redis) {
    await redis.set(META_KEY, meta);
  } else {
    const store = getLocalStore();
    store.meta = meta;
    saveLocalStore(store);
  }
}

export async function storeSheetLeads(
  sheetId: string,
  data: StoredSheetData
): Promise<void> {
  const redis = getRedis();
  if (redis) {
    await redis.set(`${SHEET_KEY_PREFIX}:${sheetId}`, data);
  } else {
    const store = getLocalStore();
    store.sheets[sheetId] = data;
    saveLocalStore(store);
  }
}

// Batch store multiple sheets at once using Redis pipeline
export async function storeMultipleSheetLeads(
  entries: { sheetId: string; data: StoredSheetData }[]
): Promise<void> {
  if (entries.length === 0) return;
  const redis = getRedis();
  if (redis) {
    const pipeline = redis.pipeline();
    for (const { sheetId, data } of entries) {
      pipeline.set(`${SHEET_KEY_PREFIX}:${sheetId}`, data);
    }
    await pipeline.exec();
  } else {
    const store = getLocalStore();
    for (const { sheetId, data } of entries) {
      store.sheets[sheetId] = data;
    }
    saveLocalStore(store);
  }
}

export async function removeStoredSheet(sheetId: string): Promise<void> {
  const key = `${SHEET_KEY_PREFIX}:${sheetId}`;
  const redis = getRedis();
  if (redis) {
    await redis.del(key);
    // Remove from meta's sheetKeys
    const meta = await getSyncMetadata();
    meta.sheetKeys = meta.sheetKeys.filter((k) => k !== key);
    await storeSyncMetadata(meta);
  } else {
    const store = getLocalStore();
    delete store.sheets[sheetId];
    saveLocalStore(store);
  }
}
