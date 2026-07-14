import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { SheetConfig, TrackedSheet } from "@/types/sheet";

const CONFIG_PATH = join(process.cwd(), "sheets-config.json");
const REDIS_KEY = "sheets-config";

// Lazy-init Redis client only when env vars are present (Vercel production)
// Supports both Vercel KV (KV_REST_API_*) and Upstash Redis (UPSTASH_REDIS_REST_*)
function getRedis() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return null;
  }
  const { Redis } = require("@upstash/redis") as typeof import("@upstash/redis");
  return new Redis({ url, token });
}

// --- File-based storage (local dev) ---

function getConfigFromFile(): SheetConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as SheetConfig;
  } catch {
    return { sheets: [] };
  }
}

function saveConfigToFile(config: SheetConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

// --- Public async API ---

/**
 * Raw Google spreadsheet id for a tracked sheet. New records carry it
 * explicitly; legacy records (bare-id) derive it by stripping the optional
 * `::tab` suffix — which for a bare id returns the id unchanged.
 */
export function resolveSpreadsheetId(s: Pick<TrackedSheet, "id" | "spreadsheetId">): string {
  return s.spreadsheetId ?? s.id.split("::")[0];
}

export async function getConfig(): Promise<SheetConfig> {
  const redis = getRedis();
  const raw = redis
    ? (await redis.get<SheetConfig>(REDIS_KEY)) || { sheets: [] }
    : getConfigFromFile();
  // Backfill spreadsheetId in-memory so every caller has the raw id (does not
  // rewrite storage — legacy bare-id records stay exactly as saved).
  return {
    ...raw,
    sheets: (raw.sheets || []).map((s) => ({ ...s, spreadsheetId: resolveSpreadsheetId(s) })),
  };
}

export async function saveConfig(config: SheetConfig): Promise<void> {
  const redis = getRedis();
  if (redis) {
    await redis.set(REDIS_KEY, config);
  } else {
    saveConfigToFile(config);
  }
}

export async function addSheet(sheet: TrackedSheet): Promise<SheetConfig> {
  const config = await getConfig();
  // Identity is (spreadsheet + tab), not the spreadsheet alone — so two tabs
  // of one spreadsheet can be tracked separately. Only the exact same tab is
  // a duplicate.
  const tabOf = (s: TrackedSheet) => (s.sheetName || "Leads");
  const already = config.sheets.some(
    (s) => resolveSpreadsheetId(s) === resolveSpreadsheetId(sheet) && tabOf(s) === tabOf(sheet),
  );
  if (already) {
    throw new Error("This tab of the spreadsheet is already tracked");
  }
  config.sheets.push(sheet);
  await saveConfig(config);
  return config;
}

export async function removeSheet(sheetId: string): Promise<SheetConfig> {
  const config = await getConfig();
  config.sheets = config.sheets.filter((s) => s.id !== sheetId);
  await saveConfig(config);
  return config;
}

export function extractSheetId(input: string): string {
  const match = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]+$/.test(input.trim())) return input.trim();
  throw new Error("Could not extract sheet ID from input");
}
