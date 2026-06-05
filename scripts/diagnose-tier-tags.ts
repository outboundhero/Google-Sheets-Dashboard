/**
 * READ-ONLY. Diagnoses why specific client tags (e.g. TGS, JPC&A) don't resolve
 * to a tier. Dumps:
 *   - the raw Client Tracker abbreviation + plan + status rows that look related
 *   - the tracked-sheets config clientTags that look related
 *   - whether resolveTier-style matching would connect them
 *
 * Usage:  npx tsx scripts/diagnose-tier-tags.ts TGS "JPC&A" JPC
 */
import { config } from "dotenv";
import { resolve } from "path";
import { google } from "googleapis";
import { Redis } from "@upstash/redis";

config({ path: resolve(__dirname, "../.env.local") });

const NEEDLES = process.argv.slice(2).map((t) => t.trim()).filter(Boolean);
const CLIENT_TRACKER_SHEET_ID = "1MGqSgGNoeN6WgjZnT7_Ij_nZftyyj7Z9DT77rVYLKuQ";
const CLIENT_TRACKER_TAB = "Client Tracker";

function getSheets() {
  const jwt = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return google.sheets({ version: "v4", auth: jwt });
}
function getRedis() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function looksRelated(s: string): boolean {
  const up = s.toUpperCase();
  return NEEDLES.some((n) => up.includes(n.toUpperCase().replace(/&.*$/, "").slice(0, 3)) || up.includes(n.toUpperCase()));
}

async function main() {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: CLIENT_TRACKER_SHEET_ID,
    range: `'${CLIENT_TRACKER_TAB}'!A1:W`,
    valueRenderOption: "FORMATTED_VALUE",
  });
  const rows = res.data.values || [];
  const hdr = (rows[0] || []).map((h: string) => String(h).toLowerCase().trim());
  const abbrI = hdr.findIndex((h: string) => h.includes("abbrev"));
  const planI = hdr.indexOf("plan");
  const statusI = hdr.indexOf("status");
  console.log(`Header abbr col=${abbrI} (${rows[0]?.[abbrI]}), plan col=${planI} (${rows[0]?.[planI]}), status col=${statusI} (${rows[0]?.[statusI]})\n`);

  console.log("=== CLIENT TRACKER rows matching needles ===");
  for (const r of rows.slice(1)) {
    const abbr = String(r[abbrI] || "").trim();
    if (!abbr) continue;
    if (looksRelated(abbr)) {
      console.log(`  abbr="${abbr}"  plan="${planI >= 0 ? r[planI] : "?"}"  status="${statusI >= 0 ? r[statusI] : "?"}"`);
    }
  }

  const redis = getRedis();
  if (redis) {
    const cfg = (await redis.get<{ sheets: { clientTag: string; name: string }[] }>("sheets-config")) || { sheets: [] };
    console.log(`\n=== TRACKED-SHEETS config clientTags matching needles (of ${cfg.sheets.length}) ===`);
    for (const s of cfg.sheets) {
      if (looksRelated(s.clientTag || "") || looksRelated(s.name || "")) {
        console.log(`  clientTag="${s.clientTag}"  name="${s.name}"`);
      }
    }
  } else {
    console.log("\n(no Redis env — skipping tracked-sheets dump)");
  }
}
main().catch((e) => { console.error("ERROR:", e?.message || e); process.exit(1); });
