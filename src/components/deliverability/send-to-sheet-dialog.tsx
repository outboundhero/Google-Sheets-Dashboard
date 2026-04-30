"use client";

import { useState, useEffect, useMemo } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, Search, X, ExternalLink } from "lucide-react";

interface SheetOption {
  clientTag: string;
  sheetName: string;
  sheetId: string;
}

interface SendToSheetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedDomains: string[];
  /** Tags on the selected domains, for auto-detecting client */
  domainTags: string[];
  /** Called when user confirms */
  onConfirm: (info: { domains: string[]; clientTag: string }) => void;
}

export function SendToSheetDialog({
  open, onOpenChange, selectedDomains, domainTags, onConfirm,
}: SendToSheetDialogProps) {
  const [sheets, setSheets] = useState<SheetOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Auto-detect most common tag that matches a tracked sheet
  const autoDetectedTag = useMemo(() => {
    if (sheets.length === 0 || domainTags.length === 0) return null;
    const sheetTags = new Set(sheets.map((s) => s.clientTag));
    const freq = new Map<string, number>();
    for (const tag of domainTags) {
      if (sheetTags.has(tag)) {
        freq.set(tag, (freq.get(tag) || 0) + 1);
      }
    }
    if (freq.size === 0) return sheets[0]?.clientTag || null;
    let best = "";
    let bestCount = 0;
    for (const [tag, count] of freq) {
      if (count > bestCount) { best = tag; bestCount = count; }
    }
    return best;
  }, [sheets, domainTags]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setLoading(true);
    // Fetch tracked sheets directly from config (instant, no Google Sheets API calls)
    fetch("/api/sheets")
      .then((r) => r.json())
      .then((data) => {
        const list: SheetOption[] = (Array.isArray(data) ? data : []).map((s: { id: string; name: string; clientTag: string }) => ({
          clientTag: s.clientTag,
          sheetName: s.name,
          sheetId: s.id,
        }));
        setSheets(list);
      })
      .catch(() => setError("Failed to load sheets"))
      .finally(() => setLoading(false));
  }, [open]);

  // Set auto-detected tag once sheets load
  useEffect(() => {
    if (autoDetectedTag && !selectedTag) {
      setSelectedTag(autoDetectedTag);
    }
  }, [autoDetectedTag, selectedTag]);

  // Reset when dialog closes
  useEffect(() => {
    if (!open) { setSelectedTag(null); setSheets([]); setSearch(""); }
  }, [open]);

  const selectedSheet = sheets.find((s) => s.clientTag === selectedTag);

  const filteredSheets = useMemo(() => {
    if (!search) return sheets;
    const q = search.toLowerCase();
    return sheets.filter((s) => s.clientTag.toLowerCase().includes(q) || s.sheetName.toLowerCase().includes(q));
  }, [sheets, search]);

  const handleConfirm = () => {
    if (!selectedTag) return;
    onConfirm({ domains: selectedDomains, clientTag: selectedTag });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:!max-w-md max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Send to Domains Sheet</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="text-sm text-destructive py-4">{error}</div>
        ) : sheets.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4">No tracked sheets found.</div>
        ) : (
          <div className="space-y-3 flex-1 overflow-hidden flex flex-col">
            <p className="text-sm text-muted-foreground">
              {selectedDomains.length} domain{selectedDomains.length !== 1 ? "s" : ""} will be added to the Domains tab.
              Duplicates are automatically skipped.
            </p>

            <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-1.5">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search client sheets…" className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground" />
              {search && <button onClick={() => setSearch("")}><X className="h-3 w-3 text-muted-foreground hover:text-foreground" /></button>}
            </div>

            <div className="flex-1 overflow-y-auto rounded-lg border divide-y">
              {filteredSheets.length === 0 ? (
                <div className="text-center py-6 text-sm text-muted-foreground">No sheets match</div>
              ) : (
                filteredSheets.map((s) => {
                  const selected = selectedTag === s.clientTag;
                  return (
                    <button key={s.clientTag} onClick={() => setSelectedTag(s.clientTag)}
                      className={`flex items-center gap-2.5 w-full px-3 py-2 text-sm text-left transition-colors ${selected ? "bg-primary/10" : "hover:bg-muted/50"}`}>
                      <div className={`h-4 w-4 rounded-full border flex items-center justify-center shrink-0 transition-colors ${selected ? "bg-primary border-primary" : "border-muted-foreground/30"}`}>
                        {selected && <div className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />}
                      </div>
                      <span className="font-medium shrink-0">{s.clientTag}</span>
                      <span className="text-muted-foreground truncate">— {s.sheetName}</span>
                    </button>
                  );
                })
              )}
            </div>

            {selectedSheet && (
              <div className="flex items-center justify-between text-xs text-muted-foreground rounded-lg border bg-muted/30 px-3 py-2">
                <span>Target: <span className="font-medium text-foreground">{selectedSheet.sheetName}</span> &rarr; Domains tab</span>
                <a
                  href={`https://docs.google.com/spreadsheets/d/${selectedSheet.sheetId}/edit`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-primary hover:underline shrink-0 ml-2"
                >
                  Open <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button size="sm" disabled={!selectedTag} onClick={handleConfirm}>
                Send to Sheet
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
