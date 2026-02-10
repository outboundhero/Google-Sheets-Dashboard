"use client";

import { useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

interface Props {
  onSuccess: () => void;
}

export function AddSheetDialog({ onSuccess }: Props) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [clientTag, setClientTag] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!url.trim() || !clientTag.trim()) return;
    setLoading(true);
    try {
      const res = await fetch("/api/sheets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), clientTag: clientTag.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to add sheet");
        return;
      }
      toast.success(`Added "${data.name}" successfully`);
      setUrl("");
      setClientTag("");
      setOpen(false);
      onSuccess();
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-2 h-4 w-4" />
          Add Sheet
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Google Sheet</DialogTitle>
          <DialogDescription>
            Paste the Google Sheet URL or ID. The sheet must be shared with the
            service account email.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Sheet URL or ID</label>
            <Input
              placeholder="https://docs.google.com/spreadsheets/d/..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">
              Client Tag <span className="text-destructive">*</span>
            </label>
            <Input
              placeholder="e.g. SCS, Acme Corp"
              value={clientTag}
              onChange={(e) => setClientTag(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Sheets with the same Client Tag will have their data merged.
            </p>
          </div>
          <div className="rounded-lg bg-muted/50 border p-3">
            <p className="text-xs text-muted-foreground">
              Share your sheet with this email as Viewer:
            </p>
            <p className="text-xs font-mono mt-1 break-all text-foreground">
              n8n-1-291@outreachify-486520.iam.gserviceaccount.com
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={loading || !url.trim() || !clientTag.trim()}
          >
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Add Sheet
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
