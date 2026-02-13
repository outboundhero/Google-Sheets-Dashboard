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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

interface Props {
  onSuccess: () => void;
}

export function AddSheetDialog({ onSuccess }: Props) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [clientTag, setClientTag] = useState("");
  const [availableSheets, setAvailableSheets] = useState<string[]>([]);
  const [selectedSheet, setSelectedSheet] = useState("");
  const [sheetTitle, setSheetTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<"input" | "selectSheet">("input");

  const handleValidate = async () => {
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
        toast.error(data.error || "Failed to validate sheet");
        return;
      }

      // If we got available sheets, show the selection step
      if (data.availableSheets) {
        setAvailableSheets(data.availableSheets);
        setSheetTitle(data.title);
        setSelectedSheet(data.availableSheets[0] || "");
        setStep("selectSheet");
      }
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async () => {
    if (!url.trim() || !clientTag.trim() || !selectedSheet) return;
    setLoading(true);
    try {
      const res = await fetch("/api/sheets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          clientTag: clientTag.trim(),
          sheetName: selectedSheet,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to add sheet");
        return;
      }
      toast.success(`Added "${data.name}" successfully`);
      setUrl("");
      setClientTag("");
      setAvailableSheets([]);
      setSelectedSheet("");
      setSheetTitle("");
      setStep("input");
      setOpen(false);
      onSuccess();
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      // Reset state when closing
      setUrl("");
      setClientTag("");
      setAvailableSheets([]);
      setSelectedSheet("");
      setSheetTitle("");
      setStep("input");
    }
    setOpen(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-2 h-4 w-4" />
          Add Sheet
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {step === "input" ? "Add Google Sheet" : "Select Sheet Tab"}
          </DialogTitle>
          <DialogDescription>
            {step === "input"
              ? "Paste the Google Sheet URL or ID. The sheet must be shared with the service account email."
              : `Select which tab to use from "${sheetTitle}"`}
          </DialogDescription>
        </DialogHeader>

        {step === "input" ? (
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
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Sheet Tab <span className="text-destructive">*</span>
              </label>
              <Select value={selectedSheet} onValueChange={setSelectedSheet}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a sheet tab" />
                </SelectTrigger>
                <SelectContent>
                  {availableSheets.map((sheet) => (
                    <SelectItem key={sheet} value={sheet}>
                      {sheet}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                This is the tab/sheet within the spreadsheet that contains your lead data.
              </p>
            </div>
          </div>
        )}

        <DialogFooter>
          {step === "selectSheet" && (
            <Button variant="outline" onClick={() => setStep("input")}>
              Back
            </Button>
          )}
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          {step === "input" ? (
            <Button
              onClick={handleValidate}
              disabled={loading || !url.trim() || !clientTag.trim()}
            >
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Next
            </Button>
          ) : (
            <Button
              onClick={handleSubmit}
              disabled={loading || !selectedSheet}
            >
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add Sheet
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
