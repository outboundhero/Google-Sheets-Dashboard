import { getSheetsClient } from "./google-sheets";

const SPREADSHEET_ID = "1bo0pkEmljm37HmsDY9q2SY2fv7lkGvXsJCEEaZ23NRM";
const TAB_GID = 2000704576;
const COLUMN_HEADER = "Secondary Domain";

function colLetter(zeroBasedIndex: number): string {
  let n = zeroBasedIndex;
  let s = "";
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

function escapeSheetName(name: string): string {
  // Sheet names with spaces/special chars must be wrapped in single quotes.
  return /^[A-Za-z0-9_]+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

export async function appendToSecondaryDomainColumn(
  domains: string[]
): Promise<{ added: number; skipped: number }> {
  const cleanDomains = domains.map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (cleanDomains.length === 0) return { added: 0, skipped: 0 };

  const sheets = await getSheetsClient();

  // 1. Find tab title + row count from gid.
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: "sheets(properties(sheetId,title,gridProperties))",
  });
  const tab = meta.data.sheets?.find((s) => s.properties?.sheetId === TAB_GID);
  if (!tab?.properties?.title) {
    throw new Error(`Could not find tab with gid=${TAB_GID} in spreadsheet`);
  }
  const tabTitle = tab.properties.title;
  const rowCount = tab.properties.gridProperties?.rowCount || 1000;
  const escapedTab = escapeSheetName(tabTitle);

  // 2. Read header row (row 1) and find the "Secondary Domain" column.
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${escapedTab}!1:1`,
  });
  const headers = headerRes.data.values?.[0] || [];
  const colIdx = headers.findIndex(
    (h) => typeof h === "string" && h.trim().toLowerCase() === COLUMN_HEADER.toLowerCase()
  );
  if (colIdx < 0) {
    throw new Error(`Column "${COLUMN_HEADER}" not found in tab "${tabTitle}" header row`);
  }
  const letter = colLetter(colIdx);

  // 3. Read column from row 2 onward; find the next empty row.
  const colRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${escapedTab}!${letter}2:${letter}`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const existing = colRes.data.values || [];
  const existingSet = new Set<string>();
  let firstEmptyRowIdx = existing.length; // 0-based offset from row 2
  for (let i = 0; i < existing.length; i++) {
    const v = (existing[i]?.[0] ?? "").toString().trim().toLowerCase();
    if (v) existingSet.add(v);
  }
  // If column is sparse, prefer first truly-empty cell (don't insert in gaps; append after last value)
  let lastFilled = -1;
  for (let i = 0; i < existing.length; i++) {
    const v = (existing[i]?.[0] ?? "").toString().trim();
    if (v) lastFilled = i;
  }
  firstEmptyRowIdx = lastFilled + 1;

  // 4. Dedupe.
  const toWrite = cleanDomains.filter((d) => !existingSet.has(d));
  const skipped = cleanDomains.length - toWrite.length;
  if (toWrite.length === 0) return { added: 0, skipped };

  const startRow = 2 + firstEmptyRowIdx;
  const endRow = startRow + toWrite.length - 1;
  const range = `${escapedTab}!${letter}${startRow}:${letter}${endRow}`;
  const values = toWrite.map((d) => [d]);

  const doWrite = () =>
    sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    });

  // 5. Extend the tab if the target rows don't exist yet.
  if (endRow > rowCount) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [
          {
            appendDimension: {
              sheetId: TAB_GID,
              dimension: "ROWS",
              length: endRow - rowCount + 100,
            },
          },
        ],
      },
    });
  }

  try {
    await doWrite();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (!msg.includes("exceeds grid limits")) throw err;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [
          {
            appendDimension: {
              sheetId: TAB_GID,
              dimension: "ROWS",
              length: toWrite.length + 100,
            },
          },
        ],
      },
    });
    await doWrite();
  }

  return { added: toWrite.length, skipped };
}
