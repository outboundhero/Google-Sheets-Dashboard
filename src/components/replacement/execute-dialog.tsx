"use client";

// Replacement EXECUTION dialog — confirm-first, reversible-only.
// Runs the plan for ONE client+instance by reusing the proven deliverability
// endpoints. Order: add replacements (tag → redirect → attach → sheet →
// whitelist), then remove burnt from campaigns (reversible). The burnt domains
// are NOT deleted at the provider here — they're scheduled for the 5-day
// vendor-delete grace via /api/replacement/record. Every action is logged.
import { useState } from "react";
import { Loader2, CheckCircle2, AlertCircle, Circle, ShieldAlert } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface ExecuteInputs {
  clientTag: string;
  instance: string;
  instancesQuery: string;          // e.g. "instances=facilityreach"
  redirectUrl: string | null;
  targetCampaigns: { id: number; name: string }[];
  replacementDomains: string[];    // reserves to add (zero-blocker replace rows only)
  removeDomains: string[];         // all burnt domains to remove from campaigns
}

type StepState = "queued" | "running" | "done" | "failed" | "skipped";
interface Step { key: string; label: string; state: StepState; note?: string }

const RETRY = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callJson(url: string, body: unknown, retries = RETRY): Promise<{ ok: boolean; data: unknown; error?: string }> {
  let lastErr = "";
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const text = await res.text();
      let data: unknown = null;
      try { data = text ? JSON.parse(text) : null; } catch { lastErr = "non-JSON response"; if (i < retries - 1) { await sleep(800 * (i + 1)); continue; } return { ok: false, data: null, error: lastErr }; }
      if (res.ok) return { ok: true, data };
      lastErr = (data as { error?: string })?.error || `HTTP ${res.status}`;
      if (i < retries - 1) { await sleep(800 * (i + 1)); continue; }
      return { ok: false, data, error: lastErr };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : "request failed";
      if (i < retries - 1) { await sleep(800 * (i + 1)); continue; }
    }
  }
  return { ok: false, data: null, error: lastErr };
}

function Dot({ s }: { s: StepState }) {
  if (s === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500 shrink-0" />;
  if (s === "done") return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />;
  if (s === "failed") return <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />;
  if (s === "skipped") return <Circle className="h-3.5 w-3.5 text-zinc-400 shrink-0" />;
  return <Circle className="h-3.5 w-3.5 text-zinc-300 dark:text-zinc-600 shrink-0" />;
}

export function ExecuteDialog({
  open, onOpenChange, inputs, onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  inputs: ExecuteInputs;
  onDone: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);

  const { clientTag, instance, instancesQuery, redirectUrl, targetCampaigns, replacementDomains, removeDomains } = inputs;

  const setStep = (key: string, patch: Partial<Step>) =>
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)));

  const record = (payload: unknown) =>
    fetch("/api/replacement/record", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(() => {});

  const run = async () => {
    setRunning(true);
    // Build the step list up-front so the user sees the full plan executing.
    const plan: Step[] = [];
    const addRepl = replacementDomains.length > 0;
    if (addRepl) {
      plan.push({ key: "tag", label: `Tag ${replacementDomains.length} reserve domain(s) → ${clientTag}`, state: "queued" });
      plan.push({ key: "redirect", label: `Set redirect → ${redirectUrl ? redirectUrl.replace(/^https?:\/\//, "") : "(none)"}`, state: redirectUrl ? "queued" : "skipped" });
      for (const c of targetCampaigns) plan.push({ key: `attach:${c.id}`, label: `Attach to "${c.name}"`, state: "queued" });
      plan.push({ key: "sheet", label: "Add to client domains sheet", state: "queued" });
      plan.push({ key: "whitelist", label: "Queue whitelist email (6:30am PST)", state: "queued" });
    }
    if (removeDomains.length > 0) {
      plan.push({ key: "discover", label: `Find campaigns for ${removeDomains.length} burnt domain(s)`, state: "queued" });
      plan.push({ key: "remove", label: "Remove burnt domains from campaigns", state: "queued" });
      plan.push({ key: "schedule", label: "Schedule vendor cancellation (+5 days)", state: "queued" });
    }
    setSteps(plan);

    // ── ADD REPLACEMENTS ────────────────────────────────────────────────
    if (addRepl) {
      setStep("tag", { state: "running" });
      const tagRes = await callJson("/api/deliverability/bulk-tags", { action: "add", tagNames: [clientTag], domains: replacementDomains });
      setStep("tag", { state: tagRes.ok ? "done" : "failed", note: tagRes.ok ? undefined : tagRes.error });
      record({ events: [{ instance, clientTag, eventType: tagRes.ok ? "tagged" : "error", detail: tagRes.ok ? `tagged ${replacementDomains.length}` : tagRes.error }] });

      if (redirectUrl) {
        setStep("redirect", { state: "running" });
        const rRes = await callJson("/api/deliverability/change-redirect", { dryRun: false, domains: replacementDomains, newUrl: redirectUrl });
        setStep("redirect", { state: rRes.ok ? "done" : "failed", note: rRes.ok ? undefined : rRes.error });
        record({ events: [{ instance, clientTag, eventType: rRes.ok ? "redirect_set" : "error", detail: rRes.ok ? redirectUrl : rRes.error }] });
      }

      for (const c of targetCampaigns) {
        setStep(`attach:${c.id}`, { state: "running" });
        const aRes = await callJson(`/api/deliverability/attach-domains-to-campaign?instance=${instance}`, { campaign_id: c.id, domains: replacementDomains });
        setStep(`attach:${c.id}`, { state: aRes.ok ? "done" : "failed", note: aRes.ok ? undefined : aRes.error });
        record({ events: [{ instance, clientTag, eventType: aRes.ok ? "attached" : "error", detail: aRes.ok ? c.name : `${c.name}: ${aRes.error}` }] });
      }

      setStep("sheet", { state: "running" });
      const sRes = await callJson("/api/deliverability/send-to-sheet", { domains: replacementDomains, clientTag });
      setStep("sheet", { state: sRes.ok ? "done" : "failed", note: sRes.ok ? undefined : sRes.error });

      setStep("whitelist", { state: "running" });
      const wRes = await callJson("/api/deliverability/whitelist/queue", { domains: replacementDomains, clientTag });
      setStep("whitelist", { state: wRes.ok ? "done" : "failed", note: wRes.ok ? undefined : wRes.error });

      record({ lifecycle: replacementDomains.map((d) => ({ instance, domain: d, state: "assigned" as const, clientTag })) });
    }

    // ── REMOVE BURNT ────────────────────────────────────────────────────
    if (removeDomains.length > 0) {
      setStep("discover", { state: "running" });
      const dRes = await callJson(`/api/deliverability/remove-from-campaigns?${instancesQuery}`, { domains: removeDomains, discover: true });
      const campaigns = ((dRes.data as { campaigns?: unknown[] })?.campaigns) || [];
      setStep("discover", { state: dRes.ok ? "done" : "failed", note: dRes.ok ? `${campaigns.length} campaign(s)` : dRes.error });

      if (dRes.ok && campaigns.length > 0) {
        setStep("remove", { state: "running" });
        const rmRes = await callJson(`/api/deliverability/remove-from-campaigns?${instancesQuery}`, { domains: removeDomains, campaigns });
        setStep("remove", { state: rmRes.ok ? "done" : "failed", note: rmRes.ok ? undefined : rmRes.error });
      } else {
        setStep("remove", { state: "skipped", note: "no campaigns to remove from" });
      }

      setStep("schedule", { state: "running" });
      await record({
        events: removeDomains.map((d) => ({ instance, domain: d, clientTag, eventType: "removed" as const, detail: "removed from campaigns; vendor-delete scheduled +5d" })),
        lifecycle: removeDomains.map((d) => ({ instance, domain: d, state: "removed" as const, clientTag })),
        cancellations: removeDomains.map((d) => ({ instance, domain: d, clientTag, reason: "burnt — replaced" })),
      });
      setStep("schedule", { state: "done", note: "vendor delete in 5 days (not yet fired)" });
    }

    setRunning(false);
    setFinished(true);
  };

  const close = () => { onOpenChange(false); if (finished) onDone(); };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !running) close(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Execute replacement — {clientTag} <span className="text-muted-foreground font-normal">({instance})</span></DialogTitle>
        </DialogHeader>

        {steps.length === 0 ? (
          <div className="space-y-3 text-sm">
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-amber-600 dark:text-amber-400">
              <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
              <span>This performs <b>real</b> actions for {clientTag}. Burnt domains are removed from campaigns (reversible) and scheduled for vendor-delete in <b>5 days</b> — nothing is deleted at the provider now.</span>
            </div>
            <ul className="space-y-1.5 text-muted-foreground">
              <li>➕ Add <b className="text-emerald-500">{replacementDomains.length}</b> replacement domain(s) → tag, set redirect{redirectUrl ? ` (${redirectUrl.replace(/^https?:\/\//, "")})` : ""}, attach to <b>{targetCampaigns.length}</b> campaign(s), sheet + whitelist.</li>
              <li>➖ Remove <b className="text-amber-500">{removeDomains.length}</b> burnt domain(s) from campaigns + schedule cancellation (+5d).</li>
            </ul>
            {replacementDomains.length === 0 && removeDomains.length === 0 && (
              <p className="text-destructive">Nothing to execute for this client.</p>
            )}
          </div>
        ) : (
          <ul className="space-y-1.5 max-h-72 overflow-y-auto text-xs">
            {steps.map((s) => (
              <li key={s.key} className={`flex items-center gap-2 ${s.state === "skipped" ? "opacity-60" : ""}`}>
                <Dot s={s.state} />
                <span className="flex-1">{s.label}</span>
                {s.note && <span className={`text-[10px] truncate max-w-[180px] italic ${s.state === "failed" ? "text-red-500" : "text-muted-foreground"}`} title={s.note}>{s.note}</span>}
              </li>
            ))}
          </ul>
        )}

        <DialogFooter>
          {!finished && steps.length === 0 && (
            <>
              <Button variant="ghost" onClick={close} disabled={running}>Cancel</Button>
              <Button onClick={run} disabled={running || (replacementDomains.length === 0 && removeDomains.length === 0)}>
                {running && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />} Run replacement
              </Button>
            </>
          )}
          {!finished && steps.length > 0 && (
            <Button disabled className="gap-1.5"><Loader2 className="h-4 w-4 animate-spin" /> Running…</Button>
          )}
          {finished && <Button onClick={close}>Done</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
