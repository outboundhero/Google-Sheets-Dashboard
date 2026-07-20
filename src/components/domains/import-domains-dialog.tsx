"use client";

import { useState } from "react";
import { Upload, Loader2, FileText } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";

interface ImportResult {
  added: number;
  updated: number;
  skippedInvalid: number;
  duplicates: number;
}

export function ImportDomainsDialog({ onImported }: { onImported: () => void }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const onFile = async (file: File | null) => {
    if (!file) return;
    const content = await file.text();
    setText((prev) => (prev.trim() ? prev + "\n" + content : content));
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/domains/inventory/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, createdBy: user?.email || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setResult(data as ImportResult);
      onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5">
          <Upload className="h-3.5 w-3.5" /> Import domains
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import domains</DialogTitle>
          <DialogDescription>
            Paste a list (one per line, or comma-separated) or upload a CSV/TXT. These are stored with source
            <span className="font-medium"> Manual</span> and checked for in-use + provider like Porkbun domains.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
            placeholder={"example.com\nanotherdomain.co\n…"}
            className="w-full text-sm rounded-lg border bg-background px-3 py-2 outline-none focus:ring-1 focus:ring-primary font-mono"
          />
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer w-fit hover:text-foreground">
            <FileText className="h-3.5 w-3.5" />
            <span>Upload CSV / TXT</span>
            <input
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              className="hidden"
              onChange={(e) => onFile(e.target.files?.[0] || null)}
            />
          </label>

          {error && (
            <div className="text-xs text-destructive border border-destructive/30 bg-destructive/5 rounded-lg px-3 py-2">{error}</div>
          )}
          {result && (
            <div className="text-xs text-emerald-600 border border-emerald-500/30 bg-emerald-500/5 rounded-lg px-3 py-2">
              Added {result.added} · flagged {result.updated} existing · {result.duplicates} dupes · {result.skippedInvalid} invalid skipped.
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Close</Button>
          <Button size="sm" onClick={submit} disabled={busy || !text.trim()} className="gap-1.5">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
