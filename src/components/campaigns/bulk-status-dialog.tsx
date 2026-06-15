"use client";

import { useMemo } from "react";
import { Pause, Play, Archive, AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

export type BulkAction = "pause" | "resume" | "archive";

export interface BulkSelectedRow {
  instance: BisonInstanceSlug;
  id: number;
  name: string;
  status: string;
}

const ACTION_LABEL: Record<BulkAction, string> = {
  pause: "Pause",
  resume: "Resume",
  archive: "Archive",
};

const ACTION_VERB: Record<BulkAction, string> = {
  pause: "paused",
  resume: "resumed",
  archive: "archived",
};

// The status that an action's no-op target is currently in. e.g. running
// "pause" on a campaign already at "paused" is a no-op for our user.
const NO_OP_STATUS: Record<BulkAction, string[]> = {
  pause: ["paused", "archived", "completed"],
  resume: ["active", "completed", "archived"],
  archive: ["archived"],
};

const normStatus = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: BulkAction;
  rows: BulkSelectedRow[];
  onConfirm: () => void;
}

export function BulkStatusDialog({ open, onOpenChange, action, rows, onConfirm }: Props) {
  const byInstance = useMemo(() => {
    const m = new Map<BisonInstanceSlug, number>();
    for (const r of rows) m.set(r.instance, (m.get(r.instance) || 0) + 1);
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const noOpCount = useMemo(
    () => rows.filter((r) => NO_OP_STATUS[action].includes(normStatus(r.status))).length,
    [rows, action],
  );

  const isArchive = action === "archive";
  const Icon = action === "pause" ? Pause : action === "resume" ? Play : Archive;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className={`h-4 w-4 ${isArchive ? "text-red-500" : ""}`} />
            {ACTION_LABEL[action]} {rows.length.toLocaleString("en-US")} campaign{rows.length === 1 ? "" : "s"}?
          </DialogTitle>
          <DialogDescription>
            {isArchive
              ? "Archived campaigns are hidden from the active list and can't be resumed. Make sure this is what you want."
              : `Each campaign will be ${ACTION_VERB[action]} in its Bison instance. Live progress appears above the table.`}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 text-sm space-y-1.5">
          <div className="text-xs font-medium text-zinc-500 mb-1">Breakdown by instance</div>
          {byInstance.map(([inst, count]) => (
            <div key={inst} className="flex justify-between">
              <span className="text-zinc-600 dark:text-zinc-300">{inst}</span>
              <span className="font-medium">{count.toLocaleString("en-US")}</span>
            </div>
          ))}
        </div>

        {noOpCount > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-950/20 p-3 text-xs">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
            <div className="text-amber-700 dark:text-amber-200">
              {noOpCount.toLocaleString("en-US")} campaign{noOpCount === 1 ? " is" : "s are"} already at a status where{" "}
              <strong>{ACTION_LABEL[action].toLowerCase()}</strong> is a no-op. They&apos;ll still be sent to Bison
              (idempotent) but won&apos;t change.
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={() => { onConfirm(); onOpenChange(false); }}
            className={isArchive ? "bg-red-600 hover:bg-red-700 text-white" : ""}
          >
            <Icon className="h-4 w-4 mr-2" />
            {ACTION_LABEL[action]} {rows.length}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
