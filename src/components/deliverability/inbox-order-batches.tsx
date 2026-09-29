"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Clock, Loader2 } from "lucide-react";
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

/** The line about talking to the provider and Bison — or nothing when it's all done. */
function signalLine(b: InboxOrderBatch): { text: string; tone: "muted" | "warn" } | null {
  const provider = PROVIDER_LABEL[b.provider] ?? b.provider;
  if (b.settingUp > 0) {
    if (b.checkOverdue) {
      return {
        text: b.lastCheckedAt
          ? `Last status check with ${provider} was ${ago(b.lastCheckedAt)} — overdue`
          : `No status check with ${provider} yet, ${ago(b.placedAt).replace(" ago", "")} after placing — overdue`,
        tone: "warn",
      };
    }
    return {
      text: b.lastCheckedAt
        ? `Last status check with ${provider} ${ago(b.lastCheckedAt)} · LeadSync checks every 6 hours`
        : `Waiting for the first status check · LeadSync checks with ${provider} every 6 hours`,
      tone: "muted",
    };
  }
  if (b.missingMailboxes > 0) {
    const short = b.partial === 1 ? "1 domain" : `${n(b.partial)} domains`;
    return {
      text: `${n(b.missingMailboxes)} mailbox${b.missingMailboxes === 1 ? "" : "es"} didn't reach Bison across ${short} — those can be re-pushed from ${provider}`,
      tone: "warn",
    };
  }
  return null;
}

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

function BatchCard({ b }: { b: InboxOrderBatch }) {
  const [open, setOpen] = useState(false);
  const [showLive, setShowLive] = useState(false);
  const health = healthOf(b);
  const chip = HEALTH_CHIP[health];
  const signal = signalLine(b);
  // Everything that isn't simply "live with every mailbox" goes first; the
  // healthy domains sit behind a toggle so a 262-domain order stays readable.
  const flagged = b.members.filter((m) => m.state !== "live");
  const liveOnly = b.members.filter((m) => m.state === "live");
  const shown = showLive ? [...flagged, ...liveOnly] : flagged;

  return (
    <div className="rounded-lg border bg-card">
      <button onClick={() => setOpen((v) => !v)} className="w-full px-4 py-3 text-left hover:bg-muted/30 transition-colors">
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

        {signal && (
          <div className={`mt-1 pl-7 flex items-center gap-1.5 text-xs ${signal.tone === "warn" ? "text-amber-600" : "text-muted-foreground"}`}>
            {signal.tone === "warn" ? <AlertTriangle className="h-3 w-3 shrink-0" /> : <Clock className="h-3 w-3 shrink-0" />}
            {signal.text}
          </div>
        )}
      </button>

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
}: {
  batches: InboxOrderBatch[];
  isLoading: boolean;
  error: string | null;
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
      {batches.map((b) => <BatchCard key={b.key} b={b} />)}
    </div>
  );
}
