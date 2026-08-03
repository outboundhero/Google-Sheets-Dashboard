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
  /** Force mode: re-queue for the next 6:30 AM PT batch even if the domains
   *  were already sent (Spencer's "force push", for when a client's recipient
   *  was wrong/bounced). Only changes copy + the confirm handler's intent. */
  force?: boolean;
}

export function SendToSheetDialog({
  open, onOpenChange, selectedDomains, domainTags, onConfirm, force = false,
}: SendToSheetDialogProps) {
  const [sheets, setSheets] = useState<SheetOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Auto-detect most common tag that matches a tracked sheet. Sheet clientTags
  // may carry a ": Leads"-style suffix while Bison tags are bare — match on the
  // bare prefix. No match → no preselect (never guess an unrelated sheet).
  const autoDetectedTag = useMemo(() => {
    if (sheets.length === 0 || domainTags.length === 0) return null;
    const bare = (t: string) => t.split(":")[0].trim().toUpperCase();
    const byBare = new Map<string, string>();
    for (const s of sheets) {
      const k = bare(s.clientTag);
      if (k && !byBare.has(k)) byBare.set(k, s.clientTag);
    }
    const freq = new Map<string, number>();
    for (const tag of domainTags) {
      const hit = byBare.get(bare(tag));
      if (hit) freq.set(hit, (freq.get(hit) || 0) + 1);
    }
    if (freq.size === 0) return null;
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
          <DialogTitle>{force ? "Force Re-queue Whitelist" : "Whitelist Domains"}</DialogTitle>
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
              {force ? (
                <>
                  {selectedDomains.length} domain{selectedDomains.length !== 1 ? "s" : ""} will be re-queued for the next
                  6:30&nbsp;AM&nbsp;PT whitelist email — <span className="font-medium text-foreground">even if they were already sent</span>.
                  Use this when the client&apos;s recipient was wrong and the email must go out again. Recipients are pulled
                  fresh from ReplyRouter at send time.
                </>
              ) : (
                <>
                  {selectedDomains.length} domain{selectedDomains.length !== 1 ? "s" : ""} will be added to the Domains tab
                  and the client&apos;s contacts will be emailed now to whitelist them. Duplicates and
                  already-whitelisted domains are skipped.
                </>
              )}
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
                {force ? "Force Re-queue" : "Whitelist & Send"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
