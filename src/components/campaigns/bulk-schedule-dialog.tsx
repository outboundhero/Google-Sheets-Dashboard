"use client";

import { useMemo, useState } from "react";
import { CalendarClock, Loader2, Lock, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { US_CA_TIMEZONES, isUsCaTimezone, timezoneLabel } from "@/lib/campaigns/timezones";
import type { CampaignData } from "@/lib/hooks/use-campaigns";

export function BulkScheduleDialog({ open, onOpenChange, selected, onDone }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  selected: CampaignData[];
  onDone: () => void;
}) {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [tz, setTz] = useState("");            // "" = keep existing
  const [includeLocked, setIncludeLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: number; failed: number; skipped: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const locked = useMemo(() => selected.filter((c) => c.sched_timezone && !isUsCaTimezone(c.sched_timezone)), [selected]);
  const changing = [start && "start time", end && "end time", tz && "timezone"].filter(Boolean) as string[];
  const nothingSet = changing.length === 0;
  const affected = selected.length - (includeLocked ? 0 : locked.length);

  const apply = async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      const res = await fetch("/api/campaigns/schedule", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: selected.map((c) => ({ instance: c.instance, id: c.id })),
          start_time: start || undefined, end_time: end || undefined, timezone: tz || undefined, includeLocked,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setResult({ ok: data.ok, failed: data.failed, skipped: data.skipped });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) { onOpenChange(v); if (!v) { setResult(null); setError(null); } } }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><CalendarClock className="h-4 w-4 text-primary" /> Bulk edit schedule</DialogTitle>
          <DialogDescription>Change the sending window and/or timezone on the selected campaigns. Leave a field blank to keep each campaign&apos;s current value. Days of the week are preserved.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <Field label="Start time"><input type="time" value={start} onChange={(e) => setStart(e.target.value)} className="w-full text-xs rounded-md border bg-background px-2 py-1.5 outline-none focus:ring-1 focus:ring-primary" /></Field>
            <Field label="End time"><input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="w-full text-xs rounded-md border bg-background px-2 py-1.5 outline-none focus:ring-1 focus:ring-primary" /></Field>
            <Field label="Timezone">
              <select value={tz} onChange={(e) => setTz(e.target.value)} className="w-full text-xs rounded-md border bg-background px-2 py-1.5 outline-none focus:ring-1 focus:ring-primary">
                <option value="">Keep existing</option>
                {US_CA_TIMEZONES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
          </div>

          {locked.length > 0 && (
            <label className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-500 cursor-pointer">
              <input type="checkbox" checked={includeLocked} onChange={(e) => setIncludeLocked(e.target.checked)} className="mt-0.5" />
              <span className="flex items-center gap-1"><Lock className="h-3 w-3" /> {locked.length} campaign{locked.length === 1 ? "" : "s"} use a non-US/Canada timezone and are locked by default. Check to include them.</span>
            </label>
          )}

          {/* Preview */}
          <div className="rounded-lg border bg-muted/30 px-3 py-2 text-[11px]">
            {nothingSet ? (
              <span className="text-muted-foreground">Set at least one field above.</span>
            ) : (
              <span className="text-muted-foreground">
                Applying to <span className="font-semibold text-foreground">{affected}</span> campaign{affected === 1 ? "" : "s"}: changing <span className="text-foreground">{changing.join(", ")}</span>
                {tz && <> → timezone <span className="text-foreground">{timezoneLabel(tz)}</span></>}
                {(start || end) && <> → window <span className="text-foreground">{start || "—"}–{end || "—"}</span></>}.
              </span>
            )}
          </div>

          {result && <div className="text-xs">Done — <span className="text-emerald-500">{result.ok} updated</span>{result.failed > 0 && <>, <span className="text-destructive">{result.failed} failed</span></>}{result.skipped > 0 && <>, {result.skipped} skipped</>}.</div>}
          {error && <div className="text-xs text-destructive">{error}</div>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>{result ? "Close" : "Cancel"}</Button>
          {!result && (
            <Button onClick={apply} disabled={busy || nothingSet || affected === 0} className="gap-1.5">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />} Apply to {affected}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="space-y-1"><span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>{children}</label>;
}
