"use client";

import { useState } from "react";
import { Trash2, ExternalLink, Loader2, Search, X } from "lucide-react";
import type { TrackedSheet } from "@/types/sheet";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface Props {
  sheets: TrackedSheet[];
  onRemoved: () => void;
}

export function TrackedSheetsList({ sheets, onRemoved }: Props) {
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const handleRemove = async (id: string, name: string) => {
    setRemovingId(id);
    try {
      const res = await fetch("/api/sheets", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        toast.error("Failed to remove sheet");
        return;
      }
      toast.success(`Removed "${name}"`);
      onRemoved();
    } catch {
      toast.error("Network error");
    } finally {
      setRemovingId(null);
    }
  };

  if (sheets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <p className="text-sm text-muted-foreground">
          No sheets tracked yet. Add your first Google Sheet above.
        </p>
      </div>
    );
  }

  const filtered = search
    ? sheets.filter(
        (s) =>
          s.name.toLowerCase().includes(search.toLowerCase()) ||
          (s.clientTag || "").toLowerCase().includes(search.toLowerCase())
      )
    : sheets;

  return (
    <div className="space-y-2">
      {/* Search */}
      <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-1.5">
        <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search sheets..."
          className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
        />
        {search && (
          <button onClick={() => setSearch("")}>
            <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
          </button>
        )}
      </div>

      {/* Compact list with scroll */}
      <div className="max-h-[400px] overflow-y-auto rounded-lg border divide-y">
        {filtered.map((sheet) => (
          <div
            key={sheet.id}
            className="flex items-center gap-3 px-3 py-2 hover:bg-muted/30 transition-colors"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium truncate">{sheet.name}</span>
                <a
                  href={`https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId ?? sheet.id.split("::")[0]}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground shrink-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                {sheet.clientTag && (
                  <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded font-medium">
                    {sheet.clientTag}
                  </span>
                )}
                {sheet.sheetName && (
                  <span className="text-[10px] text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded" title="Sheet tab">
                    tab: {sheet.sheetName}
                  </span>
                )}
                {sheet.masterView && (
                  <span
                    className="text-[10px] bg-sky-500/15 text-sky-500 px-1.5 py-0.5 rounded font-medium"
                    title={
                      sheet.clientTags?.length
                        ? `Covers exactly: ${sheet.clientTags.join(", ")} — excluded from the no-leads-in-4-days panel`
                        : "Excluded from the no-leads-in-4-days panel"
                    }
                  >
                    master view{sheet.clientTags?.length ? ` · ${sheet.clientTags.length} tags` : ""}
                  </span>
                )}
                <span className="text-[10px] text-muted-foreground">
                  {new Date(sheet.addedAt).toLocaleDateString()}
                </span>
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
              onClick={() => handleRemove(sheet.id, sheet.name)}
              disabled={removingId === sheet.id}
            >
              {removingId === sheet.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            No sheets match "{search}"
          </div>
        )}
      </div>
    </div>
  );
}
