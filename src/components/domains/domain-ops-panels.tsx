"use client";

import { useState } from "react";
import { Loader2, Clock, CheckCircle2, AlertTriangle, RefreshCw, X, PartyPopper } from "lucide-react";
import { useDomainOps } from "./domain-ops-context";
import { useDomains } from "@/lib/hooks/use-domains";
import { useBuyQueue } from "@/lib/hooks/use-buy-queue";
import { usePurchasedDomains } from "@/lib/hooks/use-purchased-domains";
import type { BulkPanel } from "@/lib/panel-runs";

function fmtCountdown(iso: string | null): string {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "now";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function DomainOpsPanels() {
  const { panels, dismiss, dismissAll, runAutoRenew, runHide, runSurbl, runSpamhaus, purchaseNotice, dismissPurchase } = useDomainOps();

  // Count chips.
  const { domains: available } = useDomains(0);
  const { counts: queueCounts, nextEligibleAt, inWindow } = useBuyQueue(20000);
  const { counts: purchasedCounts } = usePurchasedDomains();
  const queued = (queueCounts.queued ?? 0) + (queueCounts.buying ?? 0);

  const retry = (p: BulkPanel) => {
    if (p.kind === "auto-renew" && p.enabled !== undefined) runAutoRenew(p.retryDomains, p.enabled);
    else if (p.kind === "hide" && p.enabled !== undefined) runHide(p.retryDomains, p.enabled);
    else if (p.kind === "surbl") runSurbl(p.retryDomains);
    else if (p.kind === "spamhaus") runSpamhaus(p.retryDomains);
  };

  return (
    <div className="space-y-2">
      {/* Count chips */}
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <Chip>{available.length} available to buy</Chip>
        <Chip accent={queued > 0 ? "amber" : undefined}>
          {queued} in buy queue{inWindow && nextEligibleAt ? ` · next in ${fmtCountdown(nextEligibleAt)}` : ""}
        </Chip>
        <Chip accent="emerald">{purchasedCounts?.total ?? 0} purchased via LeadSync</Chip>
      </div>

      {/* Purchase success panel — stays until dismissed */}
      {purchaseNotice && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 flex items-center gap-3">
          <PartyPopper className="h-5 w-5 text-emerald-500 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
              {purchaseNotice.count} domain{purchaseNotice.count === 1 ? "" : "s"} purchased successfully
            </div>
            <div className="text-[11px] text-muted-foreground">Registered on the outboundhero Porkbun account — see the Purchased Domains tab.</div>
          </div>
          <button onClick={dismissPurchase} className="opacity-60 hover:opacity-100 shrink-0" title="Dismiss"><X className="h-4 w-4" /></button>
        </div>
      )}

      {/* Dismiss all */}
      {panels.length >= 2 && (
        <div className="flex justify-end">
          <button onClick={dismissAll} className="text-[11px] text-muted-foreground hover:text-foreground">Dismiss all</button>
        </div>
      )}

      {/* Bulk-op panels */}
      {panels.map((p) => (
        <OpPanel key={p.id} p={p} onDismiss={() => dismiss(p.id)} onRetry={() => retry(p)} />
      ))}
    </div>
  );
}

function OpPanel({ p, onDismiss, onRetry }: { p: BulkPanel; onDismiss: () => void; onRetry: () => void }) {
  const [showFails, setShowFails] = useState(false);
  const pct = p.total > 0 ? Math.min(100, (p.done / p.total) * 100) : 0;
  const finished = !p.running && !p.queued;
  return (
    <div className="rounded-lg border bg-muted/30 px-4 py-3 space-y-2">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-2 min-w-0">
          {p.queued ? <Clock className="h-3.5 w-3.5 text-amber-500 shrink-0" />
            : p.running ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
            : p.failed > 0 ? <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
            : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />}
          <span className="font-medium truncate">
            {p.queued ? `Queued — ${p.title}` : `${p.title} · ${p.done}/${p.total}`}
          </span>
        </span>
        <span className="flex items-center gap-2 shrink-0">
          {finished && p.retryDomains.length > 0 && (
            <button onClick={onRetry} className="inline-flex items-center gap-1 rounded-md border border-primary/40 text-primary px-2 py-0.5 text-[11px] hover:bg-primary/10">
              <RefreshCw className="h-3 w-3" /> Retry {p.retryDomains.length}
            </button>
          )}
          {finished && (
            <button onClick={onDismiss} className="opacity-60 hover:opacity-100" title="Dismiss"><X className="h-3.5 w-3.5" /></button>
          )}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="text-[11px] text-muted-foreground">
        <span className={p.done ? "text-emerald-500" : ""}>{p.done} done</span>
        {" · "}
        <span className={p.failed ? "text-destructive" : ""}>{p.failed} failed</span>
        {p.failures.length > 0 && (
          <button onClick={() => setShowFails((v) => !v)} className="ml-2 text-primary hover:underline">
            {showFails ? "hide" : "view"} errors
          </button>
        )}
      </div>
      {showFails && p.failures.length > 0 && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 max-h-32 overflow-y-auto space-y-0.5">
          {p.failures.slice(0, 30).map((f, i) => (
            <div key={`${f.domain}-${i}`} className="text-[10px] text-muted-foreground">
              <span className="text-foreground">{f.domain}</span> — {f.error}
            </div>
          ))}
          {p.failures.length > 30 && <div className="text-[10px] text-muted-foreground">…and {p.failures.length - 30} more</div>}
        </div>
      )}
    </div>
  );
}

function Chip({ children, accent }: { children: React.ReactNode; accent?: "emerald" | "amber" }) {
  const cls = accent === "emerald" ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-600"
    : accent === "amber" ? "border-amber-500/20 bg-amber-500/10 text-amber-600"
    : "bg-muted/40 text-muted-foreground border-border";
  return <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-medium ${cls}`}>{children}</span>;
}
