"use client";

// Bison capacity — editable limits per instance. Nick/Spencer type the
// sender-account limit Ahmad set for each workspace and hit Save; the
// auto-purchase capacity gate reads these. 0 / blank = unknown → gate off
// for that instance (no false alarms). No env vars, no redeploys.
import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Gauge, Save, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const INSTANCE_LABEL: Record<string, string> = {
  outboundhero: "OutboundHero (B2B #1)",
  cleaningoutbound: "CleaningOutbound (B2C #1)",
  facilityreach: "FacilityReach (B2B #2)",
  outboundclean: "OutboundClean (B2C #2)",
};

interface Row { instance: string; maxSenders: number; currentSenders: number }

export function BisonCapacityCard() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/replacement/bison-capacity", { cache: "no-store" });
      const d = await res.json();
      if (d?.error) throw new Error(d.error);
      setRows(d.rows || []);
      setEdits(Object.fromEntries((d.rows || []).map((r: Row) => [r.instance, r.maxSenders ? String(r.maxSenders) : ""])));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const id = setTimeout(load, 0); // deferred initial load
    return () => clearTimeout(id);
  }, [load]);

  const save = async () => {
    setSaving(true); setError(null); setSaved(false);
    try {
      const limits = Object.fromEntries(Object.entries(edits).map(([k, v]) => [k, Number(v) || 0]));
      const res = await fetch("/api/replacement/bison-capacity", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limits }),
      });
      const d = await res.json();
      if (d?.error) throw new Error(d.error);
      setRows(d.rows || []);
      setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium">
              <Gauge className="h-4 w-4" />
              Bison capacity limits
            </div>
            <div className="text-[11px] text-muted-foreground">
              Sender-account limit per workspace (ask Ahmad). Purchases pause + alert when an order won&apos;t fit. Blank = unknown → check off for that instance.
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={load} disabled={loading} className="h-8 px-2">
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
            <Button size="sm" onClick={save} disabled={saving || !rows} className="gap-2 h-8">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save
            </Button>
            {saved && <span className="text-xs text-emerald-500">Saved</span>}
          </div>
        </div>

        {error && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}

        {rows && (
          <div className="grid gap-2 sm:grid-cols-2">
            {rows.map((r) => {
              const limit = Number(edits[r.instance]) || 0;
              const pct = limit > 0 ? Math.round((r.currentSenders / limit) * 100) : null;
              return (
                <div key={r.instance} className="rounded-lg border px-3 py-2 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">{INSTANCE_LABEL[r.instance] ?? r.instance}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {r.currentSenders.toLocaleString()} senders now
                      {pct !== null && (
                        <span className={pct >= 90 ? " text-destructive font-medium" : pct >= 75 ? " text-amber-500" : ""}> · {pct}% full</span>
                      )}
                    </div>
                  </div>
                  <input
                    type="number"
                    min={0}
                    placeholder="limit"
                    value={edits[r.instance] ?? ""}
                    onChange={(e) => setEdits((s) => ({ ...s, [r.instance]: e.target.value }))}
                    className="w-28 text-sm px-2 py-1 rounded-lg border bg-background text-right"
                  />
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
