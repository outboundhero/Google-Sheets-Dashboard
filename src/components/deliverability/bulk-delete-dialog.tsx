"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, AlertTriangle, Trash2 } from "lucide-react";

interface DomainInfo {
  domain: string;
  inbox_count: number;
}

interface BulkDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedDomains: DomainInfo[];
  onSuccess: () => void;
}

export function BulkDeleteDialog({
  open,
  onOpenChange,
  selectedDomains,
  onSuccess,
}: BulkDeleteDialogProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    inboxesDeleted: number;
    domainsDeleted: number;
    failed: number;
  } | null>(null);

  const totalInboxes = selectedDomains.reduce((sum, d) => sum + d.inbox_count, 0);

  const handleDelete = async () => {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch("/api/deliverability/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domains: selectedDomains.map((d) => d.domain),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to delete");
      setResult({
        inboxesDeleted: data.inboxesDeleted,
        domainsDeleted: data.domainsDeleted,
        failed: data.failed || 0,
      });
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    } finally {
      setDeleting(false);
    }
  };

  const handleClose = () => {
    setResult(null);
    setError(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="h-4 w-4 text-destructive" />
            Delete Domains
          </DialogTitle>
        </DialogHeader>

        {result ? (
          <div className="py-6 text-center space-y-2">
            <div className={`font-medium ${result.failed > 0 ? "text-amber-500" : "text-emerald-500"}`}>
              {result.failed > 0 ? "Partially deleted" : "Deleted successfully"}
            </div>
            <div className="text-sm text-muted-foreground">
              {result.inboxesDeleted} inbox{result.inboxesDeleted !== 1 ? "es" : ""} deleted,{" "}
              {result.domainsDeleted} domain{result.domainsDeleted !== 1 ? "s" : ""} removed
            </div>
            {result.failed > 0 && (
              <div className="text-xs text-destructive mt-1">
                {result.failed} inbox{result.failed !== 1 ? "es" : ""} failed to delete from EmailBison and remain in the dashboard
              </div>
            )}
            <Button variant="outline" size="sm" className="mt-3" onClick={handleClose}>
              Close
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <div className="text-sm">
                This will permanently delete{" "}
                <span className="font-semibold">{totalInboxes} inbox{totalInboxes !== 1 ? "es" : ""}</span>{" "}
                across{" "}
                <span className="font-semibold">
                  {selectedDomains.length} domain{selectedDomains.length !== 1 ? "s" : ""}
                </span>{" "}
                from EmailBison. This action cannot be undone.
              </div>
            </div>

            <div className="max-h-48 overflow-y-auto rounded-lg border divide-y">
              {selectedDomains.map((d) => (
                <div key={d.domain} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span className="truncate">{d.domain}</span>
                  <span className="text-muted-foreground text-xs shrink-0 ml-2">
                    {d.inbox_count} inbox{d.inbox_count !== 1 ? "es" : ""}
                  </span>
                </div>
              ))}
            </div>

            {error && <div className="text-xs text-destructive">{error}</div>}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={deleting}
                onClick={handleDelete}
              >
                {deleting && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                Delete {selectedDomains.length} Domain{selectedDomains.length !== 1 ? "s" : ""}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
