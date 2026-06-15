"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, CheckCircle2, XCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useOffboardings, type OffboardingItem } from "@/lib/hooks/use-pending-offboardings";

function formatDate(iso: string): string {
  // ISO date "2026-06-15" → "Jun 15, 2026"
  const [y, m, d] = iso.split("-").map((s) => parseInt(s, 10));
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

interface Preview {
  clientTag: string;
  instancesTargeted: string[];
  activeCampaigns: number;
  inboxesWithTag: number;
  affectedDomains: number;
}

export function PendingOffboardingsCard() {
  const { pending, isLoading, mutate } = useOffboardings();
  const [open, setOpen] = useState<{ kind: "offboard" | "skip"; item: OffboardingItem } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isLoading || pending.length === 0) return null;

  function openOffboard(item: OffboardingItem) {
    setOpen({ kind: "offboard", item });
    setPreview(null);
    setError(null);
    setLoadingPreview(true);
    fetch(`/api/churn-offboarding/preview?clientAbbr=${encodeURIComponent(item.clientAbbr)}`)
      .then((r) => r.json())
      .then((p) => { if (p?.error) setError(p.error); else setPreview(p); })
      .catch((e) => setError(e instanceof Error ? e.message : "preview failed"))
      .finally(() => setLoadingPreview(false));
  }

  function openSkip(item: OffboardingItem) {
    setOpen({ kind: "skip", item });
    setError(null);
  }

  async function submit(decision: "confirm" | "skip") {
    if (!open) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/churn-offboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientAbbr: open.item.clientAbbr,
          churnDate: open.item.churnDate,
          decision,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error || `HTTP ${res.status}`);
        return;
      }
      setOpen(null);
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="rounded-xl border-2 border-amber-400 dark:border-amber-600 bg-amber-50 dark:bg-amber-950/30 p-4">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle className="h-4.5 w-4.5 text-amber-500 dark:text-amber-400 shrink-0" />
          <div>
            <h3 className="text-sm font-semibold text-amber-700 dark:text-amber-200">Pending offboardings</h3>
            <p className="text-[11px] text-amber-600/70 dark:text-amber-400/70">
              {pending.length} client{pending.length === 1 ? "" : "s"} need a decision —
              auto-fires the day after the churn date
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          {pending.map((item) => (
            <div
              key={`${item.clientAbbr}|${item.churnDate}`}
              className="flex items-center justify-between rounded-lg bg-amber-100 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800/40 px-3 py-2 text-sm gap-2"
            >
              <div className="min-w-0 flex-1">
                <span className="font-medium text-amber-800 dark:text-amber-100 truncate">
                  {item.companyName}{" "}
                  <span className="font-normal text-amber-600/70 dark:text-amber-400/60">({item.clientAbbr})</span>
                </span>
                <span className="ml-2 text-[10px] text-amber-700 dark:text-amber-300 bg-amber-200 dark:bg-amber-900/60 rounded px-1.5 py-0.5">
                  churn {formatDate(item.churnDate)}
                </span>
              </div>
              <div className="flex gap-2 shrink-0">
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => openOffboard(item)}
                  className="bg-amber-600 hover:bg-amber-700 text-white"
                >
                  Offboard
                </Button>
                <Button size="sm" variant="ghost" onClick={() => openSkip(item)}>
                  Skip
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Offboard confirmation */}
      <Dialog
        open={open?.kind === "offboard"}
        onOpenChange={(o) => { if (!o && !submitting) setOpen(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Offboard {open?.item.companyName}?</DialogTitle>
            <DialogDescription>
              This pauses every active campaign for the <strong>{open?.item.clientAbbr}</strong> tag
              and detaches the tag from every inbox carrying it (the tag itself stays in the Bison
              instance — only the sender-tag links are removed).
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 text-sm space-y-1">
            {loadingPreview ? (
              <div className="flex items-center gap-2 text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading impact…</div>
            ) : preview ? (
              <>
                <div className="flex justify-between"><span className="text-zinc-500">Active campaigns to pause</span><span className="font-medium">{preview.activeCampaigns.toLocaleString("en-US")}</span></div>
                <div className="flex justify-between"><span className="text-zinc-500">Inboxes to detag</span><span className="font-medium">{preview.inboxesWithTag.toLocaleString("en-US")}</span></div>
                <div className="flex justify-between"><span className="text-zinc-500">Affected domains</span><span className="font-medium">{preview.affectedDomains.toLocaleString("en-US")}</span></div>
                <div className="flex justify-between"><span className="text-zinc-500">Instances</span><span className="font-medium text-right">{preview.instancesTargeted.join(", ")}</span></div>
              </>
            ) : (
              <div className="text-zinc-500">No impact data available.</div>
            )}
          </div>
          {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(null)} disabled={submitting}>Cancel</Button>
            <Button
              onClick={() => submit("confirm")}
              disabled={submitting || loadingPreview}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              {submitting ? <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Offboarding…</> : <><CheckCircle2 className="h-4 w-4 mr-2" /> Offboard now</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Skip confirmation */}
      <Dialog
        open={open?.kind === "skip"}
        onOpenChange={(o) => { if (!o && !submitting) setOpen(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Skip offboarding for {open?.item.clientAbbr}?</DialogTitle>
            <DialogDescription>
              Marks this offboarding as skipped permanently. The 9 AM PST auto-fire will NOT run
              for {open?.item.clientAbbr}. Campaigns stay active, tag stays on inboxes.
            </DialogDescription>
          </DialogHeader>
          {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(null)} disabled={submitting}>Cancel</Button>
            <Button
              variant="default"
              onClick={() => submit("skip")}
              disabled={submitting}
            >
              {submitting ? <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Saving…</> : <><XCircle className="h-4 w-4 mr-2" /> Skip permanently</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
