"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Clock, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BISON_INSTANCES, isInstanceSlug } from "@/lib/bison-instances";
import {
  DEFAULT_INBOXING_ACCOUNT,
  INBOXING_ACCOUNT_LABEL,
  toInboxingAccount,
} from "@/lib/inboxing-accounts";
import type { BatchMember, InboxOrderBatch, MemberState } from "@/lib/inbox-order-batches";

// One row per order as it was placed (a Create or a Bulk Import), with what
// happened to it — instead of one row per domain. Nick, 2026-09-30: "I just
// want to make sure this runs as smooth as possible so there's no question
// whether anything went wrong when LeadSync is trying to talk to the API."

const PROVIDER_LABEL: Record<string, string> = {
  scaledmail: "ScaledMail",
  milkbox: "MilkBox",
  inboxing: "Inboxing",
};

const n = (x: number) => x.toLocaleString();

function ago(iso: string | null): string {
  if (!iso) return "";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function providerLabel(b: InboxOrderBatch): string {
  const p = PROVIDER_LABEL[b.provider] ?? b.provider;
  if (b.provider !== "inboxing") return p;
  const acct = toInboxingAccount(b.inboxingAccount) ?? DEFAULT_INBOXING_ACCOUNT;
  return `${p} · ${INBOXING_ACCOUNT_LABEL[acct].replace("Inboxing – ", "")}`;
}

const instanceLabel = (slug: string) => (isInstanceSlug(slug) ? BISON_INSTANCES[slug].label : slug);

type Health = "attention" | "overdue" | "progress" | "short" | "complete" | "removed";

function healthOf(b: InboxOrderBatch): Health {
  if (b.failed > 0 || b.stuck > 0) return "attention";
  if (b.checkOverdue) return "overdue";
  if (b.settingUp > 0 || b.uploading > 0) return "progress";
  if (b.missingMailboxes > 0) return "short";
  if (b.live === 0 && b.removed > 0) return "removed";
  return "complete";
}

const HEALTH_CHIP: Record<Health, { label: string; className: string }> = {
  attention: { label: "Needs attention", className: "bg-destructive/10 text-destructive border-destructive/30" },
  overdue: { label: "Not checked recently", className: "bg-amber-500/10 text-amber-600 border-amber-500/30" },
  progress: { label: "In progress", className: "bg-sky-500/10 text-sky-600 border-sky-500/30" },
  short: { label: "Mailboxes short", className: "bg-amber-500/10 text-amber-600 border-amber-500/30" },
  complete: { label: "Complete", className: "bg-emerald-500/10 text-emerald-600 border-emerald-500/30" },
  removed: { label: "Removed since", className: "bg-muted text-muted-foreground border-border" },
};

const STATE_LABEL: Record<MemberState, { label: string; className: string }> = {
  failed: { label: "failed", className: "text-destructive" },
  stuck: { label: "stuck", className: "text-destructive" },
  partial: { label: "short", className: "text-amber-600" },
  "setting-up": { label: "setting up", className: "text-sky-600" },
  uploading: { label: "uploading", className: "text-sky-600" },
  reordered: { label: "ordered again", className: "text-muted-foreground" },
  live: { label: "live", className: "text-emerald-600" },
  removed: { label: "removed", className: "text-muted-foreground" },
};

/** One sentence on where the order stands — the thing Nick reads first. */
function headline(b: InboxOrderBatch): string {
  const parts: string[] = [];
  if (b.live > 0) parts.push(`${n(b.live)} live`);
  const inFlight = b.settingUp + b.uploading;
  if (inFlight > 0) parts.push(`${n(inFlight)} being set up`);
  if (b.failed > 0) parts.push(`${n(b.failed)} failed`);
  if (b.stuck > 0) parts.push(`${n(b.stuck)} stuck`);
  if (b.reordered > 0) parts.push(`${n(b.reordered)} ordered again later`);
  if (b.removed > 0) parts.push(`${n(b.removed)} removed since`);
  return parts.join(" · ");
}

interface Signal { text: string; tone: "muted" | "warn" }

/** Lines about talking to the provider and Bison — none when it's all done. */
function signalLines(b: InboxOrderBatch): Signal[] {
  const provider = PROVIDER_LABEL[b.provider] ?? b.provider;
  const out: Signal[] = [];
  if (b.settingUp > 0) {
    if (b.checkOverdue) {
      out.push({
        text: b.lastCheckedAt
          ? `Last status check with ${provider} was ${ago(b.lastCheckedAt)} — overdue`
          : `No status check with ${provider} yet, ${ago(b.placedAt).replace(" ago", "")} after placing — overdue`,
        tone: "warn",
      });
    } else {
      out.push({
        text: b.lastCheckedAt
          ? `Last status check with ${provider} ${ago(b.lastCheckedAt)} · LeadSync checks every 6 hours`
          : `Waiting for the first status check · LeadSync checks with ${provider} every 6 hours`,
        tone: "muted",
      });
    }
  }
  if (b.missingMailboxes > 0) {
    const short = b.partial === 1 ? "1 domain" : `${n(b.partial)} domains`;
    out.push({
      text: `${n(b.missingMailboxes)} inbox${b.missingMailboxes === 1 ? "" : "es"} didn't reach Bison across ${short}`,
      tone: "warn",
    });
  }
  if (b.stuck > 0) {
    out.push({
      text: `${n(b.stuck)} domain${b.stuck === 1 ? " was" : "s were"} set up at ${provider} but never reached Bison`,
      tone: "warn",
    });
  }
  return out;
}

interface RepushResponse {
  error?: string;
  sent: number;
  jobs: number;
  skipped: number;
  throttled: number;
  failed: number;
  notAttempted: number;
  results: { outcome: string; domain: string; detail?: string }[];
}

function describeRepush(r: RepushResponse): { text: string; tone: "ok" | "warn" | "bad" } {
  const firstDetail = (o: string) => r.results.find((x) => x.outcome === o)?.detail ?? "";
  const parts: string[] = [];
  if (r.sent > 0) parts.push(`Sent ${n(r.sent)} domain${r.sent === 1 ? "" : "s"} to Inboxing's upload queue`);
  if (r.throttled > 0) parts.push(`${n(r.throttled)} in Inboxing's upload cooldown, try again later`);
  if (r.failed > 0) parts.push(`${n(r.failed)} failed (${firstDetail("failed")})`);
  if (r.skipped > 0) parts.push(`${n(r.skipped)} skipped (${firstDetail("skipped")})`);
  if (r.notAttempted > 0) parts.push(`${n(r.notAttempted)} not reached this time, click again`);
  const tone = r.failed > 0 ? "bad" : r.throttled + r.skipped + r.notAttempted > 0 ? "warn" : "ok";
  return { text: parts.join(" · ") || "Nothing to send", tone };
}

/** Domains the re-push can help: short in Bison, or set up but never landed. */
const repushable = (b: InboxOrderBatch) =>
  b.provider === "inboxing"
    ? b.members.filter((m) => m.state === "partial" || m.state === "stuck")
    : [];

function ProgressBar({ b }: { b: InboxOrderBatch }) {
  const total = Math.max(1, b.domains);
  const seg = [
    { v: b.live - b.partial, c: "bg-emerald-500" },
    { v: b.partial, c: "bg-amber-400" },
    { v: b.settingUp + b.uploading, c: "bg-sky-400" },
    { v: b.failed + b.stuck, c: "bg-destructive" },
    { v: b.reordered + b.removed, c: "bg-muted-foreground/25" },
  ];
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
      {seg.map((s, i) => s.v > 0 && <div key={i} className={s.c} style={{ width: `${(s.v / total) * 100}%` }} />)}
    </div>
  );
}

function MemberRow({ m }: { m: BatchMember }) {
  const st = STATE_LABEL[m.state];
  return (
    <tr className="border-t">
      <td className="px-3 py-1.5 font-mono text-xs">{m.domain}</td>
      <td className={`px-3 py-1.5 text-xs font-medium ${st.className}`}>{st.label}</td>
      <td className="px-3 py-1.5 text-right text-xs tabular-nums text-muted-foreground">
        {m.mailboxesInBison != null ? `${m.mailboxesInBison} / ${m.mailboxesOrdered}` : `— / ${m.mailboxesOrdered}`}
      </td>
      <td className="px-3 py-1.5 text-xs text-muted-foreground">{m.note ?? ""}</td>
    </tr>
  );
}

function BatchCard({ b, onChanged }: { b: InboxOrderBatch; onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const [showLive, setShowLive] = useState(false);
  const health = healthOf(b);
  const chip = HEALTH_CHIP[health];
  const signals = signalLines(b);
  const toPush = repushable(b);

  // A re-push only changes the counts after the next inbox sync, so remember
  // that it was done — otherwise the card looks untouched and invites a
  // second click.
  const storeKey = `inbox-orders:repushed:${b.key}`;
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState<{ text: string; tone: "ok" | "warn" | "bad" } | null>(null);
  const [lastPushed, setLastPushed] = useState<string | null>(null);
  useEffect(() => {
    try { setLastPushed(localStorage.getItem(storeKey)); } catch { /* private mode */ }
  }, [storeKey]);

  async function repush() {
    const where = instanceLabel(b.instance);
    const ok = window.confirm(
      `Re-push the missing inboxes for ${toPush.length} domain${toPush.length === 1 ? "" : "s"} (${where})?\n\n` +
      `Inboxing re-sends the domain's inboxes and Bison skips the ones it already has, so only the missing ones are added. ` +
      `This is a live action on Inboxing. The inboxes usually land within 15 minutes.`,
    );
    if (!ok) return;
    setPushing(true);
    setPushResult(null);
    try {
      const res = await fetch("/api/inbox-orders/batches/repush", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: toPush.map((m) => m.id) }),
      });
      const json = (await res.json().catch(() => ({}))) as RepushResponse;
      if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
      setPushResult(describeRepush(json));
      if (json.sent > 0) {
        const at = new Date().toISOString();
        setLastPushed(at);
        try { localStorage.setItem(storeKey, at); } catch { /* private mode */ }
      }
      onChanged?.();
    } catch (e) {
      setPushResult({ text: e instanceof Error ? e.message : "Re-push failed", tone: "bad" });
    } finally {
      setPushing(false);
    }
  }
  // Everything that isn't simply "live with every mailbox" goes first; the
  // healthy domains sit behind a toggle so a 262-domain order stays readable.
  const flagged = b.members.filter((m) => m.state !== "live");
  const liveOnly = b.members.filter((m) => m.state === "live");
  const shown = showLive ? [...flagged, ...liveOnly] : flagged;

  return (
    <div className="rounded-lg border bg-card">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`w-full px-4 pt-3 text-left hover:bg-muted/30 transition-colors ${signals.length > 0 || toPush.length > 0 ? "pb-1" : "pb-3"}`}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {open ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
          <span className="text-sm font-semibold">
            {new Date(b.placedAt).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
          </span>
          <span className="text-xs text-muted-foreground">
            {new Date(b.placedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
          </span>
          <span className="text-sm">{instanceLabel(b.instance)}</span>
          <span className="text-xs text-muted-foreground">{providerLabel(b)}</span>
          <span className={`ml-auto rounded-full border px-2 py-0.5 text-[11px] font-medium ${chip.className}`}>{chip.label}</span>
        </div>

        <div className="mt-2 grid gap-2 pl-7 sm:grid-cols-[auto_1fr] sm:items-center sm:gap-6">
          <div className="text-sm tabular-nums">
            <span className="font-semibold">{n(b.domains)}</span> domain{b.domains === 1 ? "" : "s"}
            <span className="text-muted-foreground"> · </span>
            <span className="font-semibold">{n(b.mailboxesOrdered)}</span> inboxes ordered
          </div>
          <ProgressBar b={b} />
        </div>

        <div className="mt-1.5 pl-7 text-xs text-muted-foreground">
          {headline(b)}
          {b.live > 0 && (
            <span>
              {" "}· {n(b.mailboxesInBison)} of {n(b.mailboxesExpected)} inboxes in Bison
            </span>
          )}
        </div>

      </button>

      {/* Outside the expand button: this row holds its own button. */}
      {(signals.length > 0 || toPush.length > 0) && (
        <div className="space-y-1 px-4 pb-3 pl-11">
          {signals.map((s, i) => (
            <div key={i} className={`flex items-center gap-1.5 text-xs ${s.tone === "warn" ? "text-amber-600" : "text-muted-foreground"}`}>
              {s.tone === "warn" ? <AlertTriangle className="h-3 w-3 shrink-0" /> : <Clock className="h-3 w-3 shrink-0" />}
              {s.text}
            </div>
          ))}
          {toPush.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" disabled={pushing} onClick={repush}>
                {pushing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                {pushing
                  ? "Re-pushing…"
                  : `${lastPushed ? "Re-push again" : "Re-push missing inboxes"} (${n(toPush.length)} domain${toPush.length === 1 ? "" : "s"})`}
              </Button>
              {lastPushed && !pushResult && (
                <span className="text-[11px] text-muted-foreground">
                  Re-pushed {ago(lastPushed)}. Counts update after the next inbox sync (Deliverability → Sync Inboxes, or automatically every 2 days).
                </span>
              )}
            </div>
          )}
          {pushResult && (
            <div className={`text-[11px] ${pushResult.tone === "bad" ? "text-destructive" : pushResult.tone === "warn" ? "text-amber-600" : "text-emerald-600"}`}>
              {pushResult.text}. Counts update after the next inbox sync (Deliverability → Sync Inboxes, or automatically every 2 days).
            </div>
          )}
        </div>
      )}

      {open && (
        <div className="border-t">
          {flagged.length === 0 && (
            <div className="flex items-center gap-1.5 px-4 py-3 text-xs text-emerald-600">
              <CheckCircle2 className="h-3.5 w-3.5" /> Every domain is live with all its inboxes in Bison.
            </div>
          )}
          {shown.length > 0 && (
            <table className="w-full">
              <thead>
                <tr className="text-[11px] text-muted-foreground">
                  <th className="px-3 py-1.5 text-left font-medium">Domain</th>
                  <th className="px-3 py-1.5 text-left font-medium">Status</th>
                  <th className="px-3 py-1.5 text-right font-medium">In Bison / ordered</th>
                  <th className="px-3 py-1.5 text-left font-medium">Detail</th>
                </tr>
              </thead>
              <tbody>{shown.map((m) => <MemberRow key={m.id} m={m} />)}</tbody>
            </table>
          )}
          {liveOnly.length > 0 && (
            <button
              onClick={() => setShowLive((v) => !v)}
              className="w-full border-t px-4 py-2 text-left text-xs text-muted-foreground hover:bg-muted/30"
            >
              {showLive ? "Hide" : "Show"} {flagged.length > 0 ? "" : "the "}{n(liveOnly.length)}
              {flagged.length > 0 ? " fully live" : ""} domain{liveOnly.length === 1 ? "" : "s"}
            </button>
          )}
          {b.bisonSyncedAt && (
            <div className="border-t px-4 py-1.5 text-[11px] text-muted-foreground">
              Inbox counts from the last Bison sync, {ago(b.bisonSyncedAt)}.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function InboxOrderBatches({
  batches,
  isLoading,
  error,
  onChanged,
}: {
  batches: InboxOrderBatch[];
  isLoading: boolean;
  error: string | null;
  onChanged?: () => void;
}) {
  if (isLoading && batches.length === 0) {
    return (
      <div className="rounded-md border p-6 text-center text-sm text-muted-foreground">
        <Loader2 className="inline h-4 w-4 animate-spin" /> Loading orders…
      </div>
    );
  }
  if (error && batches.length === 0) {
    return <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error}</div>;
  }
  if (batches.length === 0) {
    return (
      <div className="rounded-md border p-6 text-center text-sm text-muted-foreground">
        No orders yet. Click &quot;Create Order&quot; to start.
      </div>
    );
  }

  const attention = batches.filter((b) => healthOf(b) === "attention").length;
  const inProgress = batches.filter((b) => healthOf(b) === "progress" || healthOf(b) === "overdue").length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span><b className="text-foreground">{n(batches.length)}</b> orders</span>
        {attention > 0 && <span className="text-destructive"><b>{attention}</b> need attention</span>}
        {inProgress > 0 && <span className="text-sky-600"><b>{inProgress}</b> in progress</span>}
        <span>One row per order as placed; click an order to see its domains.</span>
      </div>
      {batches.map((b) => <BatchCard key={b.key} b={b} onChanged={onChanged} />)}
    </div>
  );
}
