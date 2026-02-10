export interface TrackedSheet {
  id: string;
  name: string;
  clientTag: string;
  addedAt: string;
}

export interface SheetConfig {
  sheets: TrackedSheet[];
}
