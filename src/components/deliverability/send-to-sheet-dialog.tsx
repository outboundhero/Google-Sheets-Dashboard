"use client";

import { useState, useEffect, useMemo } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, ChevronDown } from "lucide-react";

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
    fetch("/api/deliverability/send-to-sheet")
      .then((r) => r.json())
      .then((data) => {
        if (data.sheets) setSheets(data.sheets);
        else setError(data.error || "Failed to load sheets");
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
    if (!open) { setSelectedTag(null); setSheets([]); }
  }, [open]);

  const selectedSheet = sheets.find((s) => s.clientTag === selectedTag);

  const handleConfirm = () => {
    if (!selectedTag) return;
    onConfirm({ domains: selectedDomains, clientTag: selectedTag });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:!max-w-md">
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
          <div className="text-sm text-muted-foreground py-4">
            No tracked sheets have a &quot;Domains&quot; tab. Add a &quot;Domains&quot; tab to a client sheet first.
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {selectedDomains.length} domain{selectedDomains.length !== 1 ? "s" : ""} will be added to the Domains tab.
              Duplicates are automatically skipped.
            </p>

            {/* Client tag selector */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Client Sheet</label>
              <div className="relative">
                <select
                  value={selectedTag || ""}
                  onChange={(e) => setSelectedTag(e.target.value)}
                  className="w-full appearance-none rounded-lg border bg-background px-3 py-2 pr-8 text-sm outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="" disabled>Select a client...</option>
                  {sheets.map((s) => (
                    <option key={s.clientTag} value={s.clientTag}>
                      {s.clientTag} — {s.sheetName}
                    </option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              </div>
            </div>

            {selectedSheet && (
              <div className="text-xs text-muted-foreground rounded-lg border bg-muted/30 px-3 py-2">
                Target: <span className="font-medium text-foreground">{selectedSheet.sheetName}</span> &rarr; Domains tab
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
