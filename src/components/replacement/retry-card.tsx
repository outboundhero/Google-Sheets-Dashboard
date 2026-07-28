"use client";

// "Failed steps — retry" (Spencer's Loom + user 2026-07-29: Slack notifies,
// LeadSync retries). Lists error events from the last 7 days that carry a
// stored RetryPayload and replays the failed step against the same
// deliverability endpoints the runner uses. Admin page; self-contained.
import { useState, useEffect, useCallback } from "react";
import { RefreshCw, RotateCcw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { RetryPayload } from "@/lib/replacement/execute-runner";

const INSTANCE_SHORT: Record<string, string> = {
  outboundhero: "OH1", cleaningoutbound: "CO1", facilityreach: "FR2", outboundclean: "OC2",
};

interface ErrorEvent {
  id: number;
  instance: string | null;
  clientTag: string | null;
  detail: string | null;
  createdAt: string;
  signals: { retry?: RetryPayload } | null;
}

type RowState = "idle" | "running" | "done" | "failed";

async function post(url: string, body: unknown): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: (data as { error?: string })?.error || `HTTP ${res.status}`, data };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "request failed" };
  }
}

/** Replay one stored step. Mirrors the runner's endpoint calls exactly. */
async function replay(r: RetryPayload): Promise<{ ok: boolean; note: string }> {
  switch (r.step) {
    case "tag": {
      const res = await post("/api/deliverability/bulk-tags", { action: "add", tagNames: r.tagNames ?? [r.clientTag], domains: r.domains });
      const d = (res.data || {}) as { inboxesAffected?: number; failed?: number };
      return res.ok
        ? { ok: (d.failed ?? 0) === 0, note: `${d.inboxesAffected ?? 0} tagged${d.failed ? ` · ${d.failed} still failing` : ""}` }
        : { ok: false, note: res.error || "failed" };
    }
    case "redirect": {
      const res = await post("/api/deliverability/change-redirect", { dryRun: false, domains: r.domains, newUrl: r.newUrl });
      return { ok: res.ok, note: res.ok ? "redirect set" : res.error || "failed" };
    }
    case "attach": {
      const res = await post(`/api/deliverability/attach-domains-to-campaign?instance=${r.instance}`, { campaign_id: r.campaignId, domains: r.domains });
      const d = (res.data || {}) as { newly_attached?: number; failed?: number };
      return res.ok
        ? { ok: (d.failed ?? 0) === 0, note: `${d.newly_attached ?? 0} attached${d.failed ? ` · ${d.failed} still failing` : ""}` }
        : { ok: false, note: res.error || "failed" };
    }
    case "sheet": {
      const res = await post("/api/deliverability/send-to-sheet", { domains: r.domains, clientTag: r.clientTag });
      return { ok: res.ok, note: res.ok ? "appended to sheet" : res.error || "failed" };
    }
    case "whitelist": {
      const res = await post("/api/deliverability/whitelist/queue", { domains: r.domains, clientTag: r.clientTag });
      return { ok: res.ok, note: res.ok ? "whitelist queued" : res.error || "failed" };
    }
    case "remove": {
      const disc = await post(`/api/deliverability/remove-from-campaigns?${r.instancesQuery}`, { domains: r.domains, discover: true });
      if (!disc.ok) return { ok: false, note: disc.error || "discovery failed" };
      const campaigns = ((disc.data as { campaigns?: unknown[] })?.campaigns) || [];
      if (campaigns.length === 0) return { ok: true, note: "no campaigns left to remove from" };
      const rm = await post(`/api/deliverability/remove-from-campaigns?${r.instancesQuery}`, { domains: r.domains, campaigns });
      return { ok: rm.ok, note: rm.ok ? `removed from ${campaigns.length} campaign(s)` : rm.error || "failed" };
    }
  }
}

const STEP_EVENT: Record<RetryPayload["step"], string> = {
  tag: "tagged", redirect: "redirect_set", attach: "attached",
  sheet: "skipped", whitelist: "skipped", remove: "removed",
};

export function RetryCard() {
  const [rows, setRows] = useState<ErrorEvent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [states, setStates] = useState<Record<number, { state: RowState; note?: string }>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/replacement/events?limit=300&days=7", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        const errs = ((data.events || []) as (ErrorEvent & { eventType: string })[])
          .filter((e) => e.eventType === "error" && e.signals?.retry);
        setRows(errs);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []);
  useEffect(() => {
    const id = setTimeout(load, 0); // deferred initial load
    return () => clearTimeout(id);
  }, [load]);

  const retry = async (ev: ErrorEvent) => {
    const payload = ev.signals!.retry!;
    setStates((s) => ({ ...s, [ev.id]: { state: "running" } }));
    const result = await replay(payload);
    setStates((s) => ({ ...s, [ev.id]: { state: result.ok ? "done" : "failed", note: result.note } }));
    // audit the retry outcome so the daily report + activity log see it
    post("/api/replacement/record", {
      events: [{
        instance: payload.instance, clientTag: payload.clientTag,
        eventType: result.ok ? STEP_EVENT[payload.step] : "error",
        detail: `retry ${payload.step}${payload.campaignName ? ` "${payload.campaignName}"` : ""}: ${result.note}`,
        signals: result.ok ? null : { kind: `${payload.step}_retry_failed`, retry: payload },
      }],
    });
  };

  if (rows !== null && rows.length === 0) return null; // nothing to retry → no card

  return (
    <Card>
      <CardContent className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">Failed steps — retry</div>
            <div className="text-[11px] text-muted-foreground">Execution steps from the last 7 days that didn&apos;t fully complete. Retry replays the exact step. Slack was notified.</div>
          </div>
          <Button size="sm" variant="outline" onClick={load} disabled={loading} className="gap-2">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            {loading ? "Loading…" : "Refresh"}
          </Button>
        </div>

        {rows && rows.length > 0 && (
          <div className="rounded-lg border divide-y max-h-[360px] overflow-y-auto">
            {rows.map((ev) => {
              const st = states[ev.id] ?? { state: "idle" as RowState };
              const r = ev.signals!.retry!;
              return (
                <div key={ev.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                  <span className="text-muted-foreground tabular-nums w-[90px] shrink-0">
                    {new Date(ev.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  </span>
                  <span className="font-medium w-[80px] shrink-0">{ev.clientTag ?? "—"}</span>
                  <span className="text-muted-foreground w-[45px] shrink-0">{INSTANCE_SHORT[r.instance] ?? r.instance}</span>
                  <span className="truncate flex-1 text-muted-foreground" title={ev.detail ?? ""}>{ev.detail}</span>
                  {st.state === "done" ? (
                    <span className="text-emerald-500 shrink-0">✓ {st.note}</span>
                  ) : st.state === "failed" ? (
                    <span className="text-destructive shrink-0" title={st.note}>still failing</span>
                  ) : null}
                  <Button
                    size="sm" variant="outline"
                    onClick={() => retry(ev)}
                    disabled={st.state === "running" || st.state === "done"}
                    className="gap-1.5 h-7 shrink-0"
                  >
                    <RotateCcw className={`h-3.5 w-3.5 ${st.state === "running" ? "animate-spin" : ""}`} />
                    {st.state === "running" ? "Retrying…" : st.state === "failed" ? "Retry again" : "Retry"}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
