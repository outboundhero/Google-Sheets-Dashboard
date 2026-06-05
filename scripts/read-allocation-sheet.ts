/**
 * Read columns A and C of the client-tag allocation sheet via the project's
 * service account. Useful for verifying which client tags are mapped to which
 * group without going through the admin dashboard.
 *
 * Loads env from .env.local automatically.
 * Usage:  npx tsx scripts/read-allocation-sheet.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
import { google } from "googleapis";

config({ path: resolve(__dirname, "../.env.local") });

const SHEET_ID =
  process.env.CLIENT_TAG_ALLOCATION_SHEET_ID ||
  "1P-5H4pxB-cRO0i2tp6WjXNN77ibIB4hCnNTuyRzQOYw";

async function main() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) {
    throw new Error("GOOGLE_CLIENT_EMAIL or GOOGLE_PRIVATE_KEY missing in .env.local");
  }
  console.log(`Service account: ${clientEmail}`);
  console.log(`Sheet ID:        ${SHEET_ID}`);

  const jwt = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth: jwt });

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    fields: "sheets.properties.title",
  });
  const tab = meta.data.sheets?.[0]?.properties?.title || "Sheet1";
  console.log(`First tab:       ${tab}\n`);

  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: SHEET_ID,
    ranges: [`${tab}!A1:A`, `${tab}!C1:C`],
  });

  const colA = res.data.valueRanges?.[0]?.values || [];
  const colC = res.data.valueRanges?.[1]?.values || [];

  const groupA = colA.slice(1).map((r) => String(r[0] ?? "").trim()).filter(Boolean);
  const groupC = colC.slice(1).map((r) => String(r[0] ?? "").trim()).filter(Boolean);

  console.log(`Column A header: ${colA[0]?.[0] ?? "(empty)"}`);
  console.log(`Column C header: ${colC[0]?.[0] ?? "(empty)"}\n`);

  console.log(`=== Group 1 (Column A) — ${groupA.length} tags ===`);
  console.log(groupA.join(", "));
  console.log();
  console.log(`=== Group 2 (Column C) — ${groupC.length} tags ===`);
  console.log(groupC.join(", "));

  const setA = new Set(groupA.map((t) => t.toUpperCase()));
  const setC = new Set(groupC.map((t) => t.toUpperCase()));
  const both = [...setA].filter((t) => setC.has(t));
  if (both.length) console.log(`\n⚠ Tags in BOTH columns: ${both.join(", ")}`);
}

main().catch((e) => {
  console.error("\nERROR:", e?.message || e);
  if (e?.response?.data) console.error(JSON.stringify(e.response.data, null, 2));
  process.exit(1);
});
