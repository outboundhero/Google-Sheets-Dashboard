export interface TrackedSheet {
  // Identity of the tracked sheet. For sheets added since multi-tab support,
  // this is a composite `${spreadsheetId}::${sheetName}` so two tabs of the
  // same spreadsheet can be tracked separately. Older records have a bare
  // spreadsheet id here (still valid — resolveSpreadsheetId handles both).
  id: string;
  name: string;
  clientTag: string;
  sheetName?: string; // The specific sheet/tab name within the spreadsheet (defaults to "Leads")
  // Raw Google spreadsheet id — used for all Google Sheets API calls. Absent
  // on legacy records (derived from `id` via resolveSpreadsheetId).
  spreadsheetId?: string;
  addedAt: string;
}

export interface SheetConfig {
  sheets: TrackedSheet[];
}
