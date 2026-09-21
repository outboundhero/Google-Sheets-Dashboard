"use client";

// Anticipated clients (Spencer 2026-09-21): tell the buy list how many clients
// are expected on an upcoming start date before they exist in the Client
// Tracker. One row per start date; the group is derived (1st → Group 2,
// 15th → Group 1) and shown so a wrong mapping is visible, never silent.

import { useEffect, useState } from "react";
import { CalendarPlus, RefreshCw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface Entry { startDate: string; clients: number; tier: "1" | "2"; updatedAt: string; updatedBy: string | null }
interface Upcoming { startDate: string; group: 1 | 2 | null }

const GROUP_LABEL: Record<1 | 2, string> = { 1: "Group 1 · B2B1·OH + B2C1·CO", 2: "Group 2 · B2B2·FR + B2C2·OC" };

export function AnticipatedClientsCard() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [upcoming, setUpcoming] = useState<Upcoming[]>([]);
  const [draft, setDraft] = useState<Record<string, { clients: string; tier: "1" | "2" }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    setErr(null);
    try {
      const res = await fetch("/api/replacement/anticipated-clients", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { entries: Entry[]; upcoming: Upcoming[] };
      setEntries(json.entries);
      setUpcoming(json.upcoming);
      const d: typeof draft = {};
      for (const u of json.upcoming) {
        const e = json.entries.find((x) => x.startDate === u.startDate);
        d[u.startDate] = { clients: String(e?.clients ?? 0), tier: e?.tier ?? "1" };
      }
      setDraft(d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed to load");
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount, same as the sibling cards
  useEffect(() => { void load(); }, []);

  const save = async (startDate: string) => {
    const d = draft[startDate];
    if (!d) return;
    setBusy(startDate);
    setErr(null);
    try {
      const res = await fetch("/api/replacement/anticipated-clients", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startDate, clients: Number(d.clients) || 0, tier: d.tier }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setEntries(json.entries as Entry[]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(null);
    }
  };

  const total = entries.reduce((s, e) => s + e.clients, 0);

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium flex items-center gap-2"><CalendarPlus className="h-4 w-4" /> Anticipated clients — not in the tracker yet</div>
            <div className="text-[11px] text-muted-foreground">
              How many clients you expect on each upcoming start date. The weekly buy list adds their launch stock on that date&apos;s group (1st → Group 2, 15th → Group 1). Clear a date by setting it to 0.
            </div>
          </div>
          <div className="flex items-center gap-2">
            {total > 0 && <Badge variant="outline" className="text-[10px]">{total} anticipated</Badge>}
            <Button size="sm" variant="outline" onClick={load} className="gap-2"><RefreshCw className="h-4 w-4" /> Refresh</Button>
          </div>
        </div>

        {err && <p className="text-sm text-destructive">{err}</p>}

        <div className="rounded-lg border divide-y">
          {upcoming.map((u) => {
            const d = draft[u.startDate] ?? { clients: "0", tier: "1" as const };
            const saved = entries.find((e) => e.startDate === u.startDate);
            const dirty = saved ? String(saved.clients) !== d.clients || saved.tier !== d.tier : (Number(d.clients) || 0) > 0;
            return (
              <div key={u.startDate} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                <span className="font-mono w-[96px]">{u.startDate}</span>
                <span className="text-xs text-muted-foreground w-[220px]">{u.group ? GROUP_LABEL[u.group] : "no group (not a 1st/15th)"}</span>
                <label className="flex items-center gap-1 text-xs">
                  clients
                  <input
                    type="number" min={0} max={50}
                    className="w-16 rounded border bg-background px-2 py-1 text-sm"
                    value={d.clients}
                    onChange={(e) => setDraft((x) => ({ ...x, [u.startDate]: { ...d, clients: e.target.value } }))}
                  />
                </label>
                <label className="flex items-center gap-1 text-xs">
                  tier
                  <select
                    className="rounded border bg-background px-2 py-1 text-sm"
                    value={d.tier}
                    onChange={(e) => setDraft((x) => ({ ...x, [u.startDate]: { ...d, tier: e.target.value as "1" | "2" } }))}
                  >
                    <option value="1">Tier 1 (20 B2B / 5 B2C)</option>
                    <option value="2">Tier 2 (40 B2B / 10 B2C)</option>
                  </select>
                </label>
                <Button size="sm" variant={dirty ? "default" : "outline"} disabled={!dirty || busy === u.startDate} onClick={() => save(u.startDate)}>
                  {busy === u.startDate ? "Saving…" : "Save"}
                </Button>
                {saved && !dirty && (
                  <span className="text-[11px] text-muted-foreground">
                    saved {saved.updatedAt.slice(0, 10)}{saved.updatedBy ? ` by ${saved.updatedBy}` : ""}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
