import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { SheetConfig, TrackedSheet } from "@/types/sheet";

// Use DATA_DIR env var for persistent storage on Render, fallback to project root
const DATA_DIR = process.env.DATA_DIR || process.cwd();
const CONFIG_PATH = join(DATA_DIR, "sheets-config.json");

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function getConfig(): SheetConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as SheetConfig;
  } catch {
    return { sheets: [] };
  }
}

export function saveConfig(config: SheetConfig): void {
  ensureDataDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

export function addSheet(sheet: TrackedSheet): SheetConfig {
  const config = getConfig();
  if (config.sheets.some((s) => s.id === sheet.id)) {
    throw new Error("Sheet already tracked");
  }
  config.sheets.push(sheet);
  saveConfig(config);
  return config;
}

export function removeSheet(sheetId: string): SheetConfig {
  const config = getConfig();
  config.sheets = config.sheets.filter((s) => s.id !== sheetId);
  saveConfig(config);
  return config;
}

export function extractSheetId(input: string): string {
  // Accept a full URL or just the ID
  const match = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  // If it looks like a bare ID (no slashes)
  if (/^[a-zA-Z0-9_-]+$/.test(input.trim())) return input.trim();
  throw new Error("Could not extract sheet ID from input");
}
