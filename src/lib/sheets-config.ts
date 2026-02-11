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

export async function getConfig(): Promise<SheetConfig> {
  const redis = getRedis();
  if (redis) {
    const data = await redis.get<SheetConfig>(REDIS_KEY);
    return data || { sheets: [] };
  }
  return getConfigFromFile();
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
  if (config.sheets.some((s) => s.id === sheet.id)) {
    throw new Error("Sheet already tracked");
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
