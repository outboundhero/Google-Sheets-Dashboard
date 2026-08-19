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
  /**
   * Master data view (Spencer 2026-08-20): a combined sheet that receives the
   * leads of SEVERAL client tags at once, for viewing only. Two consequences:
   *   - `clientTags` holds the exact tags it covers (exact match, no prefix
   *     matching — "DBS" must never pull DBSNJ/DBSA/DBSF)
   *   - it is excluded from the "clients with no leads in 4 days" alert, since
   *     it isn't a client and would otherwise show up as one perpetually
   */
  masterView?: boolean;
  clientTags?: string[];
}

export interface SheetConfig {
  sheets: TrackedSheet[];
}
