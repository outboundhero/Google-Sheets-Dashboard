"use client";

// Persistent failure banner. Shows every OPEN pipeline_alerts row (whitelist
// email / sync-to-Domains-tab failures) and stays put until each is either
// retried to success or dismissed. Mounted app-wide so it's impossible to miss.
// Renders nothing when there are no open alerts (and stays silent for viewers
// whose GET is blocked). Pairs with the #leadsync-outbound Slack ping.
import { useState } from "react";
import useSWR from "swr";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PipelineAlert {
  id: string;
  source: string;
  client_tag: string | null;
  step: string;
  reason: string;
  domains_count: number;
  retry_count: number;
  created_at: string;
}

const SOURCE_LABEL: Record<string, string> = {
  "whitelist-queue": "Whitelist email",
  "send-to-sheet": "Sync to client's Domains tab",
  "stuck-campaign": "Campaign stuck in Processing",
};
// Alerts that report an external condition — nothing in LeadSync to retry.
// They auto-resolve when the condition clears; Dismiss only.
const NO_RETRY_SOURCES = new Set(["stuck-campaign"]);

const fetcher = async (url: string): Promise<PipelineAlert[]> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  // Tolerate either shape ({alerts:[…]} or a bare array) — this SWR key is shared
  // with other consumers, so never assume which shape landed in the cache.
  const arr = Array.isArray(json) ? json : json?.alerts;
  return Array.isArray(arr) ? arr : [];
};

export function PipelineAlertsBanner() {
  const { data, error, mutate } = useSWR<PipelineAlert[]>("/api/pipeline-alerts", fetcher, {
    refreshInterval: 60000,
    revalidateOnFocus: true,
    dedupingInterval: 10000,
  });
  const [busy, setBusy] = useState<Record<string, "retry" | "dismiss" | undefined>>({});
  const [note, setNote] = useState<Record<string, string>>({});

  // Blocked (viewer) or errored fetch → show nothing rather than a broken box.
  if (error || !Array.isArray(data) || data.length === 0) return null;

  const retry = async (id: string) => {
    setBusy((b) => ({ ...b, [id]: "retry" }));
    setNote((n) => ({ ...n, [id]: "" }));
    try {
      const res = await fetch("/api/pipeline-alerts/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.resolved) {
        await mutate();
      } else {
        const reason =
          (Array.isArray(json.failures) && json.failures[0]?.reason) || json.reason || json.error || "still failing";
        setNote((n) => ({ ...n, [id]: `Retry failed: ${reason}` }));
        await mutate();
      }
    } catch (e) {
      setNote((n) => ({ ...n, [id]: e instanceof Error ? e.message : "retry failed" }));
    } finally {
      setBusy((b) => ({ ...b, [id]: undefined }));
    }
  };

  const dismiss = async (id: string) => {
    if (!confirm("Dismiss this failure? It stops showing on the dashboard.")) return;
    setBusy((b) => ({ ...b, [id]: "dismiss" }));
    try {
      await fetch("/api/pipeline-alerts/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      await mutate();
    } finally {
      setBusy((b) => ({ ...b, [id]: undefined }));
    }
  };

  return (
    <div className="mb-6 rounded-lg border border-destructive/40 bg-destructive/5">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-destructive/20">
        <AlertTriangle className="h-4 w-4 text-destructive" />
        <span className="text-sm font-semibold text-destructive">
          {data.length} pipeline {data.length === 1 ? "failure needs" : "failures need"} attention
        </span>
        <span className="text-[11px] text-muted-foreground ml-1">
          Also sent to #leadsync-outbound. Retry once fixed, or dismiss to clear.
        </span>
      </div>
      <ul className="divide-y divide-destructive/10">
        {data.map((a) => {
          const label = SOURCE_LABEL[a.source] || a.source;
          const state = busy[a.id];
          return (
            <li key={a.id} className="px-4 py-3 flex items-start justify-between gap-4">
              <div className="min-w-0 space-y-0.5">
                <div className="text-sm font-medium flex items-center gap-2 flex-wrap">
                  <span>{label}</span>
                  {a.client_tag && (
                    <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-muted text-foreground">{a.client_tag}</span>
                  )}
                  <span className="text-[11px] text-muted-foreground">step: {a.step}</span>
                  {a.domains_count > 0 && (
                    <span className="text-[11px] text-muted-foreground">· {a.domains_count} domain{a.domains_count === 1 ? "" : "s"}</span>
                  )}
                  {a.retry_count > 0 && (
                    <span className="text-[11px] text-muted-foreground">· retried {a.retry_count}×</span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground break-words">{a.reason}</div>
                {note[a.id] && <div className="text-xs text-destructive">{note[a.id]}</div>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {!NO_RETRY_SOURCES.has(a.source) && (
                <Button size="sm" variant="outline" className="gap-1.5 h-8" disabled={!!state} onClick={() => retry(a.id)}>
                  <RefreshCw className={`h-3.5 w-3.5 ${state === "retry" ? "animate-spin" : ""}`} />
                  {state === "retry" ? "Retrying…" : "Retry"}
                </Button>
                )}
                <Button size="sm" variant="ghost" className="gap-1.5 h-8 text-muted-foreground" disabled={!!state} onClick={() => dismiss(a.id)}>
                  <X className="h-3.5 w-3.5" />
                  Dismiss
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
