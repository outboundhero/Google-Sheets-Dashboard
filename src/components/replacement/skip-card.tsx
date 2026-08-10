"use client";

/**
 * Skip / Unflag — Spencer's false-positive guard and his precondition for
 * turning automatic replacement on.
 *
 * Top: "Load flagged" (explicit click, no auto-run) → the current burnt list
 * from the group-driven plan (guardrail plan when groups are off). Select
 * individually / select-all → Skip. A skipped domain is never replaced,
 * removed, or counted; it stays in campaigns and keeps showing health.
 *
 * Bottom: the skip list. Each row shows whether the domain is STILL flagged
 * by current metrics or has recovered. Unskip → re-evaluated on next build.
 */
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, PauseCircle, PlayCircle, RefreshCw, ShieldOff } from "lucide-react";
import { INSTANCE_SHORT_LABELS } from "@/lib/bison-instances";

interface FlaggedItem { burntDomain: string; instance: string; clientTag: string | null; reasons: string[] }
interface SkippedBurnt { instance: string; domain: string; clientTag: string | null; reasons: string[] }
interface SkipRow { instance: string; domain: string; reason: string | null; skipped_at: string }

const short = INSTANCE_SHORT_LABELS as Record<string, string>;
const k = (instance: string, domain: string) => `${instance}:${domain.toLowerCase()}`;

export function SkipCard() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flagged, setFlagged] = useState<FlaggedItem[] | null>(null);
  const [stillFlaggedSkips, setStillFlaggedSkips] = useState<Set<string>>(new Set());
  const [skips, setSkips] = useState<SkipRow[] | null>(null);
  const [selFlagged, setSelFlagged] = useState<Set<string>>(new Set());
  const [selSkips, setSelSkips] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const loadSkips = useCallback(async () => {
    const res = await fetch("/api/replacement/skips");
    const data = await res.json().catch(() => null);
    if (res.ok && data?.skips) setSkips(data.skips);
  }, []);

  // Explicit click — builds the plan (groups when enabled, else guardrails)
  // and refreshes the skip list + each skip's still-flagged status.
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let res = await fetch("/api/replacement/plan-groups");
      let data = await res.json().catch(() => null);
      if (res.ok && data?.enabled === false) {
        res = await fetch("/api/replacement/plan");
        data = await res.json().catch(() => null);
      }
      if (!res.ok || !data || data.error) throw new Error(data?.error || `HTTP ${res.status}`);
      const items: FlaggedItem[] = (data.items || []).map((it: FlaggedItem & { burntDomain: string }) => ({
        burntDomain: it.burntDomain, instance: it.instance, clientTag: it.clientTag, reasons: it.reasons || [],
      }));
      setFlagged(items);
      setStillFlaggedSkips(new Set(((data.skippedBurnt || []) as SkippedBurnt[]).map((s) => k(s.instance, s.domain))));
      setSelFlagged(new Set());
      await loadSkips();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }, [loadSkips]);

  const post = useCallback(async (action: "add" | "remove", entries: { instance: string; domain: string; reason?: string }[]) => {
    setBusy(true);
    try {
      const res = await fetch("/api/replacement/skips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, entries }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.error) throw new Error(data?.error || `HTTP ${res.status}`);
      await load(); // rebuild so counts + still-flagged states stay honest
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }, [load]);

  const skipSelected = () => {
    if (!flagged) return;
    const entries = flagged
      .filter((f) => selFlagged.has(k(f.instance, f.burntDomain)))
      .map((f) => ({ instance: f.instance, domain: f.burntDomain, reason: f.reasons[0] || "flagged" }));
    if (entries.length > 0) void post("add", entries);
  };
  const unskipSelected = () => {
    if (!skips) return;
    const entries = skips
      .filter((s) => selSkips.has(k(s.instance, s.domain)))
      .map((s) => ({ instance: s.instance, domain: s.domain }));
    if (entries.length > 0) void post("remove", entries);
  };

  const toggle = (set: Set<string>, setter: (v: Set<string>) => void, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key); else next.add(key);
    setter(next);
  };

  const skipKeys = new Set((skips || []).map((s) => k(s.instance, s.domain)));
  // Flagged list minus already-skipped (those live in the bottom section).
  const flaggedVisible = (flagged || []).filter((f) => !skipKeys.has(k(f.instance, f.burntDomain)));
  const allFlaggedSelected = flaggedVisible.length > 0 && flaggedVisible.every((f) => selFlagged.has(k(f.instance, f.burntDomain)));

  return (
    <div className="rounded-xl border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <ShieldOff className="h-4 w-4" />
            Skip / Unflag
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Skipped domains are never auto-replaced, removed, or counted as burnt — they stay in campaigns
            and keep showing health. Unskip to re-evaluate on the next build.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
          {flagged ? "Reload flagged" : "Load flagged"}
        </Button>
      </div>

      {error && <div className="rounded-md border border-red-500/30 bg-red-950/20 px-3 py-1.5 text-xs text-red-300">{error}</div>}

      {flagged && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={allFlaggedSelected}
                onChange={() => {
                  if (allFlaggedSelected) setSelFlagged(new Set());
                  else setSelFlagged(new Set(flaggedVisible.map((f) => k(f.instance, f.burntDomain))));
                }}
              />
              <span className="font-medium">Currently flagged ({flaggedVisible.length})</span>
              <span className="text-muted-foreground">select all</span>
            </label>
            <Button size="sm" onClick={skipSelected} disabled={busy || selFlagged.size === 0}>
              <PauseCircle className="h-3.5 w-3.5 mr-1.5" />
              Skip {selFlagged.size > 0 ? selFlagged.size : ""} selected
            </Button>
          </div>
          <div className="max-h-64 overflow-y-auto rounded-md border divide-y">
            {flaggedVisible.length === 0 && (
              <div className="px-3 py-3 text-xs text-muted-foreground">Nothing flagged right now.</div>
            )}
            {flaggedVisible.map((f) => {
              const key = k(f.instance, f.burntDomain);
              return (
                <label key={key} className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-muted/40">
                  <input type="checkbox" checked={selFlagged.has(key)} onChange={() => toggle(selFlagged, setSelFlagged, key)} />
                  <span className="font-medium truncate max-w-[220px]">{f.burntDomain}</span>
                  <Badge variant="outline" className="text-[10px]">{short[f.instance] ?? f.instance}</Badge>
                  {f.clientTag && <Badge variant="outline" className="text-[10px]">{f.clientTag}</Badge>}
                  <span className="text-muted-foreground truncate flex-1" title={f.reasons.join("; ")}>{f.reasons[0]}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {skips && skips.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">Skipped ({skips.length})</span>
            <Button size="sm" variant="outline" onClick={unskipSelected} disabled={busy || selSkips.size === 0}>
              <PlayCircle className="h-3.5 w-3.5 mr-1.5" />
              Unskip {selSkips.size > 0 ? selSkips.size : ""} selected
            </Button>
          </div>
          <div className="max-h-64 overflow-y-auto rounded-md border divide-y">
            {skips.map((s) => {
              const key = k(s.instance, s.domain);
              const still = stillFlaggedSkips.has(key);
              return (
                <label key={key} className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-muted/40">
                  <input type="checkbox" checked={selSkips.has(key)} onChange={() => toggle(selSkips, setSelSkips, key)} />
                  <span className="font-medium truncate max-w-[220px]">{s.domain}</span>
                  <Badge variant="outline" className="text-[10px]">{short[s.instance] ?? s.instance}</Badge>
                  {flagged ? (
                    still ? (
                      <Badge variant="outline" className="text-[10px] text-amber-500 border-amber-500/40">still flagged</Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] text-emerald-500 border-emerald-500/40">recovered</Badge>
                    )
                  ) : null}
                  <span className="text-muted-foreground truncate flex-1" title={s.reason || undefined}>{s.reason}</span>
                  <span className="text-muted-foreground shrink-0">{new Date(s.skipped_at).toLocaleDateString()}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
