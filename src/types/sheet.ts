export interface TrackedSheet {
  id: string;
  name: string;
  clientTag: string;
  sheetName?: string; // The specific sheet/tab name within the spreadsheet (defaults to "Leads")
  addedAt: string;
}

export interface SheetConfig {
  sheets: TrackedSheet[];
}
