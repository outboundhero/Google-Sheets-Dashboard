"use client";

import { useState } from "react";
import { Trash2, ExternalLink, Loader2 } from "lucide-react";
import type { TrackedSheet } from "@/types/sheet";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface Props {
  sheets: TrackedSheet[];
  onRemoved: () => void;
}

export function TrackedSheetsList({ sheets, onRemoved }: Props) {
  const [removingId, setRemovingId] = useState<string | null>(null);

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
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-muted-foreground">
          No sheets tracked yet. Add your first Google Sheet above.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {sheets.map((sheet) => (
        <Card key={sheet.id}>
          <CardContent className="flex items-center justify-between p-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="font-medium truncate">{sheet.name}</h3>
                <a
                  href={`https://docs.google.com/spreadsheets/d/${sheet.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
              <div className="flex items-center gap-3 mt-1">
                <span className="text-xs text-muted-foreground font-mono">
                  {sheet.id.slice(0, 20)}...
                </span>
                {sheet.clientTag && (
                  <span className="text-xs bg-muted px-2 py-0.5 rounded">
                    {sheet.clientTag}
                  </span>
                )}
                <span className="text-xs text-muted-foreground">
                  Added{" "}
                  {new Date(sheet.addedAt).toLocaleDateString()}
                </span>
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-destructive shrink-0"
              onClick={() => handleRemove(sheet.id, sheet.name)}
              disabled={removingId === sheet.id}
            >
              {removingId === sheet.id ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
