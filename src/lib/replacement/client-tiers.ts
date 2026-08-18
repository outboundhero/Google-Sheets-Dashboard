// Per-client-tag TIER → tier-aware domain caps + reserve buffers.
// Additive/isolated: reads the Client Tracker tier column (col K) and turns it
// into the target-cap math Spencer specified (2026-08-04). Nothing else in the
// replacement plan is touched — the standalone shortfall card consumes this.
//
// Spencer's defaults, per CLIENT TAG, per instance (b2b/b2c independent):
//   tier 0.5 / tier 1 → B2B live cap 20, B2C live cap 5;  reserve 3 b2b / 2 b2c
//   tier 2            → B2B live cap 40, B2C live cap 10;  reserve 6 b2b / 4 b2c
import type { BisonTier } from "@/lib/bison-instances";
import { getSheetsClient } from "@/lib/google-sheets";

const CLIENT_TRACKER_SHEET_ID = "1MGqSgGNoeN6WgjZnT7_Ij_nZftyyj7Z9DT77rVYLKuQ";
const CLIENT_TRACKER_TAB = "Client Tracker";
/** Col K (0-based 10) — fallback if no "tier" header is found. */
const TIER_COL_FALLBACK_IDX = 10;

export type ClientTier = "0.5" | "1" | "2";

/** Live campaign cap per (instance tier, client tier). */
export function capFor(instanceTier: BisonTier, clientTier: ClientTier): number {
  if (instanceTier === "b2b") return clientTier === "2" ? 40 : 20;
  return clientTier === "2" ? 10 : 5; // b2c
}

/** Reserve buffer we keep on hand per tag (Spencer: on top of the live cap). */
export function reserveBufferFor(instanceTier: BisonTier, clientTier: ClientTier): number {
  if (instanceTier === "b2b") return clientTier === "2" ? 6 : 3;
  return clientTier === "2" ? 4 : 2; // b2c
}

/** Total inventory target per tag per instance = live cap + reserve buffer. */
export function totalTargetFor(instanceTier: BisonTier, clientTier: ClientTier): number {
  return capFor(instanceTier, clientTier) + reserveBufferFor(instanceTier, clientTier);
}

/** Normalise a raw tier cell to one of 0.5 / 1 / 2. Unknown/blank → "1" (the
 *  conservative low cap, so a missing tier never over-states how many to buy). */
export function normalizeTier(raw: unknown): ClientTier {
  const s = String(raw ?? "").toLowerCase().replace(/[^0-9.]/g, "").trim();
  if (s === "0.5" || s === ".5") return "0.5";
  if (s === "2" || s === "2.0") return "2";
  return "1";
}

// small module-level TTL cache — the tier column changes rarely
let cache: { at: number; map: Map<string, ClientTier> } | null = null;
// The last map that actually had rows. Served when a read fails, because a
// Sheets 429 during the big lead sync used to cache an EMPTY map for 10
// minutes — and an empty tier map makes the true-up skip all 147 pairs and
// show every instance as "covered", which is worse than stale data.
let lastGood: Map<string, ClientTier> | null = null;
const TTL_MS = 10 * 60_000;
const FAIL_RETRY_MS = 60_000; // after a failure, try the sheet again sooner

/** clientTag(UPPER) → tier. Best-effort: never throws; on a read failure it
 *  serves the last good map (retrying after FAIL_RETRY_MS). */
export async function getClientTiers(): Promise<Map<string, ClientTier>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.map;
  const map = new Map<string, ClientTier>();
  try {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: CLIENT_TRACKER_SHEET_ID,
      range: `'${CLIENT_TRACKER_TAB}'!A1:T`,
      valueRenderOption: "FORMATTED_VALUE",
    });
    const rows = res.data.values || [];
    if (rows.length >= 2) {
      const headers = (rows[0] || []).map((h) => String(h).toLowerCase().trim());
      const abbrIdx = headers.findIndex((h) => h.includes("client abbr"));
      const tierByHeader = headers.findIndex((h) => h === "tier" || h.includes("tier"));
      const tierIdx = tierByHeader >= 0 ? tierByHeader : TIER_COL_FALLBACK_IDX;
      const aIdx = abbrIdx >= 0 ? abbrIdx : 1; // col B is the usual abbr column
      for (const row of rows.slice(1)) {
        const tag = String(row[aIdx] ?? "").trim().toUpperCase();
        if (!tag) continue;
        map.set(tag, normalizeTier(row[tierIdx]));
      }
    }
  } catch (e) {
    console.error("[client-tiers] read failed:", e instanceof Error ? e.message : e);
    const fallback = lastGood ?? map;
    cache = { at: Date.now() - TTL_MS + FAIL_RETRY_MS, map: fallback };
    return fallback;
  }
  if (map.size > 0) lastGood = map;
  cache = { at: Date.now(), map };
  return map;
}
