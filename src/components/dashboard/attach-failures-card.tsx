"use client";

// Dashboard alert: clients where the replacement automation could NOT fully
// attach new domains to their campaigns (partial attach). Surfaced here so an
// unattended run never silently reports success on a broken attach — Spencer's
// hard requirement for the full automation. Read-only flag; admin re-runs from
// the Replacement page. Self-hides when there are none.
import { useState, useEffect } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";

interface Flag { instance: string | null; campaign: string; failed: number; rateLimited: number; newlyAttached: number; detail: string; at: string }
interface ClientFlag { clientTag: string; instance: string | null; totalSkipped: number; totalRateLimited: number; campaigns: Flag[]; lastAt: string }

export function AttachFailuresCard() {
  const [clients, setClients] = useState<ClientFlag[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/replacement/attach-failures", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { clients: [] }))
      .then((d) => { if (alive) setClients(d.clients || []); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  if (clients.length === 0) return null;

  return (
    <div className="rounded-xl border-2 border-orange-400 dark:border-orange-600 bg-orange-50 dark:bg-orange-950/30 p-5">
      <div className="flex items-start gap-4">
        <AlertTriangle className="h-7 w-7 text-orange-500 dark:text-orange-400 mt-0.5 shrink-0" />
        <div className="flex-1 space-y-3">
          <div>
            <h2 className="text-xl font-bold text-orange-900 dark:text-orange-100">
              Replacement attach incomplete — {clients.length} client{clients.length !== 1 ? "s" : ""}
            </h2>
            <p className="text-sm text-orange-700 dark:text-orange-400 mt-0.5">
              New domains couldn&apos;t be fully attached to campaigns (last 5 days). Rate-limited skips are retryable; disconnected ones need attention. Re-run from the{" "}
              <Link href="/replacement" className="underline font-medium">Replacement</Link> page.
            </p>
          </div>
          <div className="space-y-2">
            {clients.map((c) => (
              <div key={c.clientTag} className="rounded-lg border border-orange-300/60 dark:border-orange-700/60 bg-white/50 dark:bg-black/20">
                <button
                  onClick={() => setExpanded((v) => (v === c.clientTag ? null : c.clientTag))}
                  className="w-full flex items-center gap-3 px-3 py-2 text-left"
                >
                  <span className="font-semibold text-orange-900 dark:text-orange-100">{c.clientTag}</span>
                  {c.instance && <span className="text-[11px] text-muted-foreground">{c.instance}</span>}
                  <span className="ml-auto text-xs text-orange-700 dark:text-orange-300">
                    {c.totalSkipped} skipped
                    {c.totalRateLimited > 0 && <span className="text-primary"> · {c.totalRateLimited} retryable</span>}
                    {" "}· {c.campaigns.length} campaign{c.campaigns.length !== 1 ? "s" : ""}
                  </span>
                </button>
                {expanded === c.clientTag && (
                  <div className="border-t border-orange-300/40 dark:border-orange-700/40 divide-y divide-orange-300/20 dark:divide-orange-700/20">
                    {c.campaigns.map((f, i) => (
                      <div key={`${f.campaign}-${i}`} className="px-3 py-1.5 text-xs flex items-center justify-between gap-2">
                        <span className="truncate text-foreground/80">{f.campaign || "(campaign)"}</span>
                        <span className="shrink-0 text-muted-foreground">
                          <span className="text-emerald-500">+{f.newlyAttached}</span>
                          {" · "}
                          <span className="text-orange-500">{f.failed} skipped</span>
                          {f.rateLimited > 0 && <span className="text-primary"> ({f.rateLimited} rate-limited)</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
