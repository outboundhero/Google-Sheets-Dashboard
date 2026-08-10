"use client";

import { useMemo, useState } from "react";
import { Copy, Loader2, AlertTriangle, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { INSTANCE_SHORT_LABELS } from "@/lib/bison-instances";
import { setRoleIndex, deriveSetRole } from "@/lib/campaigns/stage";
import type { CampaignData } from "@/lib/hooks/use-campaigns";

const ROLE_OPTIONS: [string, string][] = [["google_custom", "Google + Custom"], ["outlook", "Outlook"], ["segs", "SEGs"], ["", "—"]];
const keyOf = (c: CampaignData) => `${c.instance}:${c.id}`;

export function DuplicateDialog({ open, onOpenChange, selected, allCampaigns, onQueued }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  selected: CampaignData[];
  allCampaigns: CampaignData[];
  onQueued: (enqueued: number) => void;
}) {
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roleFor = (c: CampaignData) => overrides[keyOf(c)] ?? (c.set_role ?? deriveSetRole(c.name) ?? "");

  // Group by client tag (uppercase), alphabetical; within a tag, set-role order.
  const groups = useMemo(() => {
    const m = new Map<string, CampaignData[]>();
    for (const c of selected) {
      const tag = (c.client_tag || "—").toUpperCase();
      if (!m.has(tag)) m.set(tag, []);
      m.get(tag)!.push(c);
    }
    return Array.from(m.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([tag, items]) => ({
        tag,
        instance: items[0].instance,
        items: [...items].sort((a, b) => setRoleIndex(roleFor(a)) - setRoleIndex(roleFor(b))),
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, overrides]);

  const unassigned = selected.filter((c) => !roleFor(c)).length;

  // §22 — flag sources that already have a "Copy of …" in the same instance.
  const existingCopies = useMemo(() => {
    const names = new Set(allCampaigns.map((c) => `${c.instance}::${(c.name || "").toLowerCase()}`));
    return selected.filter((c) => names.has(`${c.instance}::copy of ${(c.name || "").toLowerCase()}`)).length;
  }, [allCampaigns, selected]);

  const queue = async () => {
    setBusy(true); setError(null);
    try {
      const items = selected.map((c) => ({
        instance: c.instance, source_id: c.id, source_name: c.name,
        client_tag: (c.client_tag || "—").toUpperCase(), set_role: roleFor(c) || null,
      }));
      const res = await fetch("/api/campaigns/duplicate", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      onQueued(data.enqueued ?? 0);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to queue");
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Copy className="h-4 w-4 text-primary" /> Duplicate campaigns</DialogTitle>
          <DialogDescription>
            Each campaign is copied as a <span className="font-medium text-foreground">draft</span> (sequence preserved, no leads). Processed one client tag at a time, in order <span className="font-medium">Google + Custom → Outlook → SEGs</span>. Tags run alphabetically.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[52vh] overflow-y-auto space-y-3 pr-1">
          {groups.map((g) => (
            <div key={g.tag} className="rounded-lg border bg-card overflow-hidden">
              <div className="flex items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2">
                <span className="text-sm font-semibold">{g.tag}</span>
                <span className="inline-flex items-center rounded-md border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">{INSTANCE_SHORT_LABELS[g.instance] || g.instance}</span>
              </div>
              <div className="divide-y">
                {g.items.map((c, i) => (
                  <div key={keyOf(c)} className="flex items-center gap-2 px-3 py-2">
                    <span className="text-[10px] tabular-nums text-muted-foreground w-4">{i + 1}</span>
                    <span className="flex-1 min-w-0 text-xs truncate" title={c.name}>{c.name}</span>
                    <select
                      value={roleFor(c)}
                      onChange={(e) => setOverrides((o) => ({ ...o, [keyOf(c)]: e.target.value }))}
                      className={`text-[11px] rounded-md border bg-background px-1.5 py-1 outline-none ${!roleFor(c) ? "border-amber-500/50 text-amber-600" : ""}`}
                    >
                      {ROLE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {existingCopies > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-600">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{existingCopies} of these already have a “Copy of …” in the same instance — duplicating again will create another copy.</span>
          </div>
        )}
        {unassigned > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-600">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{unassigned} campaign{unassigned === 1 ? "" : "s"} couldn&apos;t be auto-typed. Assign a type above, or leave as “—” for a nonstandard one-off duplicate.</span>
          </div>
        )}
        {error && <div className="text-xs text-destructive">{error}</div>}

        <DialogFooter>
          <div className="flex-1 text-[11px] text-muted-foreground self-center">
            {groups.length} client tag{groups.length === 1 ? "" : "s"} · {selected.length} campaign{selected.length === 1 ? "" : "s"}
          </div>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={queue} disabled={busy || selected.length === 0} className="gap-1.5">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
            Add {selected.length} to queue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
