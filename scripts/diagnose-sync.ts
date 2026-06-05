/**
 * READ-ONLY sync diagnostic. Connects to the live Redis (Vercel KV) + Google
 * Sheets via the service account and reports, for a given client tag:
 *   - whether the tag's sheet(s) are in the tracked-sheets config and at what index
 *   - whether the sheet key is present in the sync metadata
 *   - the newest lead date STORED in Redis vs the newest lead date LIVE in the sheet
 *   - global sync metadata (lastSyncAt, totalSheets, in-progress, recent errors)
 *
 * Does NOT write anything.
 *
 * Usage:  npx tsx scripts/diagnose-sync.ts JPCIN JPCHI
 */
import { config } from "dotenv";
import { resolve } from "path";
import { google } from "googleapis";
import { Redis } from "@upstash/redis";

config({ path: resolve(__dirname, "../.env.local") });

const TAGS = process.argv.slice(2).map((t) => t.trim()).filter(Boolean);
if (TAGS.length === 0) {
  console.error("Usage: npx tsx scripts/diagnose-sync.ts <TAG> [TAG...]");
  process.exit(1);
}

function getRedis() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Redis env vars missing");
  return new Redis({ url, token });
}

function getSheets() {
  const jwt = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return google.sheets({ version: "v4", auth: jwt });
}

// mirror of normalizeGoogleDate (light version) — just try to get a comparable Date
function parseDate(raw: string): Date | null {
  if (!raw) return null;
  let d = new Date(raw);
  if (!isNaN(d.getTime())) return d;
  const amPm = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (amPm) {
    const [, mo, day, yr, hStr, min, sec, mer] = amPm;
    let h = parseInt(hStr, 10);
    if (/pm/i.test(mer) && h !== 12) h += 12;
    if (/am/i.test(mer) && h === 12) h = 0;
    d = new Date(`${yr}-${mo.padStart(2, "0")}-${day.padStart(2, "0")}T${String(h).padStart(2, "0")}:${min}:${sec ?? "00"}`);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

interface TrackedSheet { id: string; name: string; sheetName?: string; clientTag: string }

async function main() {
  const redis = getRedis();
  const sheets = getSheets();

  const cfg = (await redis.get<{ sheets: TrackedSheet[] }>("sheets-config")) || { sheets: [] };
  const meta = (await redis.get<any>("leads-store:meta")) || null;

  console.log(`\n=== GLOBAL SYNC META ===`);
  if (!meta) {
    console.log("  (no leads-store:meta found!)");
  } else {
    console.log(`  lastSyncAt:      ${meta.lastSyncAt}`);
    console.log(`  syncInProgress:  ${meta.syncInProgress}`);
    console.log(`  syncStartedAt:   ${meta.syncStartedAt}`);
    console.log(`  totalLeads:      ${meta.totalLeads}`);
    console.log(`  sheetsSuccess:   ${meta.sheetsSuccess}`);
    console.log(`  sheetsError:     ${meta.sheetsError}`);
    console.log(`  sheetKeys count: ${meta.sheetKeys?.length}`);
    if (meta.errors?.length) {
      console.log(`  recent errors:`);
      for (const e of meta.errors) console.log(`     - ${e.name} (${e.sheetId}): ${e.error}`);
    }
  }
  console.log(`\n  config.sheets.length: ${cfg.sheets.length}`);
  const sheetKeySet = new Set<string>(meta?.sheetKeys || []);

  for (const tag of TAGS) {
    const matches = cfg.sheets
      .map((s, idx) => ({ s, idx }))
      .filter(({ s }) =>
        s.clientTag?.toUpperCase() === tag.toUpperCase() ||
        s.name?.toUpperCase().includes(tag.toUpperCase())
      );

    console.log(`\n\n========== TAG: ${tag} ==========`);
    if (matches.length === 0) {
      console.log(`  ❌ NOT FOUND in tracked-sheets config (clientTag or name match). Sheet is not tracked at all.`);
      continue;
    }

    for (const { s, idx } of matches) {
      console.log(`\n  • config[${idx}/${cfg.sheets.length}]  "${s.name}"  tab="${s.sheetName || "Leads"}"  clientTag="${s.clientTag}"`);
      console.log(`    sheetId: ${s.id}`);
      const key = `leads-store:sheet:${s.id}`;
      console.log(`    in meta.sheetKeys? ${sheetKeySet.has(key) ? "yes" : "❌ NO"}`);

      // stored
      const stored = await redis.get<any>(key);
      if (!stored) {
        console.log(`    STORED: ❌ no Redis entry (never synced)`);
      } else {
        const storedDates = (stored.leads || [])
          .map((l: any) => parseDate(l.timeWeGotReply) || parseDate(l.replyTime))
          .filter(Boolean) as Date[];
        storedDates.sort((a, b) => b.getTime() - a.getTime());
        console.log(`    STORED: syncedAt=${stored.syncedAt}  leads=${stored.leads?.length}  newestLeadDate=${storedDates[0]?.toISOString().slice(0, 10) || "(none)"}`);
      }

      // live
      try {
        const tab = s.sheetName || "Leads";
        const escaped = /[^a-zA-Z0-9_]/.test(tab) ? `'${tab.replace(/'/g, "''")}'` : tab;
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: s.id,
          range: `${escaped}!A1:AZ`,
        });
        const rows = res.data.values || [];
        const headers = (rows[0] || []).map((h: string) => String(h).trim().toLowerCase());
        const replyIdx = headers.findIndex((h) => h === "time we got reply");
        const replyTimeIdx = headers.findIndex((h) => h === "reply time");
        const emailIdx = headers.findIndex((h) => h === "lead email");
        const dupIdx = headers.findIndex((h) => h === "duplicate check");
        let total = 0;
        const liveDates: Date[] = [];
        for (const r of rows.slice(1)) {
          const email = emailIdx >= 0 ? r[emailIdx] : "";
          if (!email || !email.includes("@")) continue;
          const dup = (dupIdx >= 0 ? r[dupIdx] : "")?.trim().toLowerCase();
          if (dup && dup !== "new") continue;
          total++;
          const d = parseDate(replyIdx >= 0 ? r[replyIdx] : "") || parseDate(replyTimeIdx >= 0 ? r[replyTimeIdx] : "");
          if (d) liveDates.push(d);
        }
        liveDates.sort((a, b) => b.getTime() - a.getTime());
        console.log(`    LIVE:   rows=${rows.length - 1}  validLeads=${total}  newestLeadDate=${liveDates[0]?.toISOString().slice(0, 10) || "(none)"}`);
      } catch (e: any) {
        console.log(`    LIVE:   ❌ error reading sheet: ${e?.message || e}`);
      }
    }
  }
  console.log();
}

main().catch((e) => {
  console.error("\nERROR:", e?.message || e);
  process.exit(1);
});
