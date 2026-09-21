import { Redis } from "@upstash/redis";
import { pstDateString } from "@/lib/date-utils";
import type { BisonGroup } from "@/lib/bison-instances";
import type { ClientTier } from "./client-tiers";

// Anticipated clients (Spencer 2026-09-21): launches that are not in the
// Client Tracker yet — "we expect 5 Tier 1 clients on 10/1". One entry per
// start date; the buy list adds their launch stock on the group that start
// date maps to. Group rule is Spencer's standing one (2026-08-31): a start on
// the 1st → Group 2, on the 15th → Group 1. Entries whose date has passed are
// ignored (they should be in the tracker by then), never auto-rolled.

export interface AnticipatedEntry {
  /** YYYY-MM-DD, always a 1st or a 15th. */
  startDate: string;
  clients: number;
  tier: ClientTier;
  updatedAt: string;
  updatedBy: string | null;
}

const KEY = "replacement:anticipated-clients";

function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
}

/** 1st → Group 2, 15th → Group 1, anything else → null (never guessed). */
export function groupForStartDate(startDate: string): BisonGroup | null {
  const day = Number(startDate.slice(8, 10));
  return day === 1 ? 2 : day === 15 ? 1 : null;
}

/** The next 1st and 15th on/after today (PST), in order. */
export function upcomingStartDates(today = pstDateString(new Date()), count = 4): string[] {
  const [y, m, d] = today.split("-").map(Number);
  const out: string[] = [];
  let year = y, month = m;
  for (let i = 0; out.length < count && i < 12; i++) {
    for (const day of [1, 15]) {
      if (i === 0 && day < d) continue;
      out.push(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
      if (out.length >= count) break;
    }
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return out;
}

export async function getAnticipated(): Promise<AnticipatedEntry[]> {
  const redis = getRedis();
  if (!redis) return [];
  const raw = await redis.get<AnticipatedEntry[] | string>(KEY).catch(() => null);
  const list = typeof raw === "string" ? (JSON.parse(raw) as AnticipatedEntry[]) : raw;
  return Array.isArray(list) ? list : [];
}

/** Future entries only, sorted by date — what the buy list should count. */
export async function getActiveAnticipated(today = pstDateString(new Date())): Promise<AnticipatedEntry[]> {
  return (await getAnticipated())
    .filter((e) => e.startDate >= today && e.clients > 0 && groupForStartDate(e.startDate) !== null)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
}

/** Upsert one start date; clients = 0 removes it. */
export async function setAnticipated(
  entry: { startDate: string; clients: number; tier: ClientTier },
  updatedBy: string | null,
): Promise<AnticipatedEntry[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.startDate)) throw new Error("startDate must be YYYY-MM-DD");
  if (groupForStartDate(entry.startDate) === null) throw new Error("start date must be the 1st or the 15th");
  const clients = Math.max(0, Math.min(50, Math.floor(entry.clients)));
  const redis = getRedis();
  if (!redis) throw new Error("Redis not configured");
  const list = (await getAnticipated()).filter((e) => e.startDate !== entry.startDate);
  if (clients > 0) list.push({ startDate: entry.startDate, clients, tier: entry.tier, updatedAt: new Date().toISOString(), updatedBy });
  list.sort((a, b) => a.startDate.localeCompare(b.startDate));
  await redis.set(KEY, JSON.stringify(list));
  return list;
}
