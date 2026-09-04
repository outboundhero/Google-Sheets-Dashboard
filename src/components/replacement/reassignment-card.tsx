"use client";

// Domain reassignment (Nick's 8/4 doc, item 5): client A → client B with a
// 2-day wind-down. The card only STARTS and WATCHES — every stage runs in the
// 15-min cron with retries; failures land here in loud bold, never silently.
import { useState, useEffect, useCallback } from "react";
import { ArrowRightLeft, RefreshCw, Loader2, ChevronDown, ChevronRight, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { INSTANCE_SHORT_LABELS } from "@/lib/bison-instances";

interface Row {
  instance: string;
  domain: string;
  from_tag: string;
  to_tag: string;
  stage: string;
  wait_until: string;
  attempts: number;
  last_error: string | null;
  updated_at: string;
}

const STAGE_LABEL: Record<string, string> = {
  queued: "Removing from campaigns…",
  campaigns_removed: "Wind-down (2 days)",
  retagged: "Attaching to new campaigns…",
  attached: "Redirect + whitelist + sheet…",
  done: "Done",
  failed: "FAILED",
  cancelled: "Cancelled",
};

const STAGE_CLASS: Record<string, string> = {
  queued: "bg-blue-500/15 text-blue-500",
  campaigns_removed: "bg-amber-500/15 text-amber-500",
  retagged: "bg-blue-500/15 text-blue-500",
  attached: "bg-blue-500/15 text-blue-500",
  done: "bg-emerald-500/15 text-emerald-500",
  failed: "bg-red-500/20 text-red-500",
  cancelled: "bg-muted text-muted-foreground",
};

export function ReassignmentCard() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [fromTag, setFromTag] = useState("");
  const [toTag, setToTag] = useState("");
  const [domainsText, setDomainsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/replacement/reassignments", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setRows(data.rows || []);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const active = rows.filter((r) => !["done", "failed", "cancelled"].includes(r.stage));
  const failedCount = rows.filter((r) => r.stage === "failed").length;

  const start = async () => {
    const domains = domainsText.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean);
    if (domains.length === 0 || !fromTag.trim() || !toTag.trim()) {
      setMsg("From tag, to tag and at least one domain are required.");
      return;
    }
    if (!window.confirm(
      `Reassign ${domains.length} domain(s) from ${fromTag.toUpperCase()} to ${toTag.toUpperCase()}?\n\n` +
      "They leave ALL campaigns now, wait 2 days, then get retagged, attached to the new client's campaigns (verified), redirected, whitelisted and pushed to the sheet — all automatic.",
    )) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/replacement/reassignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domains, fromTag: fromTag.trim(), toTag: toTag.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      const rej = (data.rejected || []) as { domain: string; why: string }[];
      setMsg(
        `${(data.started || []).length} started` +
        (rej.length ? ` · ${rej.length} rejected: ${rej.map((r) => `${r.domain} (${r.why})`).join(", ")}` : ""),
      );
      if ((data.started || []).length > 0) setDomainsText("");
      void load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (r: Row) => {
    if (!window.confirm(`Cancel the reassignment of ${r.domain}? It keeps its current tag but is already OUT of its campaigns — re-attach manually if it should keep sending.`)) return;
    const res = await fetch("/api/replacement/reassignments?cancel=1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instance: r.instance, domain: r.domain }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setMsg(data.error || "Cancel failed");
    }
    void load();
  };

  return (
    <div className="rounded-xl border bg-card">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-2 px-5 py-3 text-left">
        {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        <ArrowRightLeft className="h-4 w-4 text-cyan-500 shrink-0" />
        <span className="text-sm font-medium">Reassign domains to another client</span>
        {active.length > 0 && (
          <span className="text-xs rounded-full bg-cyan-500/15 text-cyan-500 px-2 py-0.5">{active.length} in flight</span>
        )}
        {failedCount > 0 && (
          <span className="text-xs font-bold rounded-full bg-red-500/20 text-red-500 px-2 py-0.5">{failedCount} FAILED</span>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">{open ? "collapse" : "expand"}</span>
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-4">
          <p className="text-[11px] text-muted-foreground">
            Client A → client B with a clean hand-over: out of all campaigns immediately, a 2-day
            wind-down for replies to stop, then retag, attach to every campaign of the new client
            (verified — a partial attach never advances), redirect to the new site, whitelist email
            queued, pushed to the new Domains sheet. During the wind-down the domain is on the
            replacement skip-list so nothing else touches it.
          </p>

          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs">
              <span className="block text-muted-foreground mb-1">From tag</span>
              <input value={fromTag} onChange={(e) => setFromTag(e.target.value)} placeholder="CCGW"
                className="h-8 w-28 rounded-md border bg-background px-2 text-sm uppercase" />
            </label>
            <label className="text-xs">
              <span className="block text-muted-foreground mb-1">To tag</span>
              <input value={toTag} onChange={(e) => setToTag(e.target.value)} placeholder="JPCI"
                className="h-8 w-28 rounded-md border bg-background px-2 text-sm uppercase" />
            </label>
            <label className="text-xs flex-1 min-w-[260px]">
              <span className="block text-muted-foreground mb-1">Domains (space / comma / newline separated)</span>
              <textarea value={domainsText} onChange={(e) => setDomainsText(e.target.value)} rows={2}
                placeholder="exampleone.com exampletwo.co"
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm font-mono" />
            </label>
            <Button size="sm" className="h-8 gap-1.5" disabled={busy} onClick={start}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRightLeft className="h-3.5 w-3.5" />}
              Start reassignment
            </Button>
            <Button size="sm" variant="outline" className="h-8 gap-1.5" disabled={loading} onClick={() => void load()}>
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
            </Button>
          </div>

          {msg && <p className="text-xs font-medium">{msg}</p>}

          {rows.length > 0 && (
            <div className="rounded-lg border divide-y">
              {rows.slice(0, 60).map((r) => (
                <div key={`${r.instance}:${r.domain}:${r.updated_at}`} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                  <span className="font-medium">{r.domain}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {INSTANCE_SHORT_LABELS[r.instance as keyof typeof INSTANCE_SHORT_LABELS] || r.instance}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{r.from_tag} → <b>{r.to_tag}</b></span>
                  {/* Stage — deliberately LOUD (bold, colored) so state and
                      failures are impossible to miss. */}
                  <span className={`text-xs font-bold uppercase tracking-wide rounded px-2 py-0.5 ${STAGE_CLASS[r.stage] || "bg-muted"}`}>
                    {STAGE_LABEL[r.stage] || r.stage}
                  </span>
                  {r.stage === "campaigns_removed" && (
                    <span className="text-[11px] text-muted-foreground">resumes {new Date(r.wait_until).toLocaleString()}</span>
                  )}
                  {r.attempts > 0 && r.stage !== "failed" && (
                    <span className="text-[11px] font-semibold text-amber-500">retry {r.attempts}/6</span>
                  )}
                  {r.last_error && (
                    <span className="basis-full text-xs font-bold text-red-500">⚠ {r.last_error}</span>
                  )}
                  {["queued", "campaigns_removed"].includes(r.stage) && (
                    <Button size="sm" variant="ghost" className="ml-auto h-6 gap-1 text-xs text-muted-foreground" onClick={() => void cancel(r)}>
                      <XCircle className="h-3 w-3" /> Cancel
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
