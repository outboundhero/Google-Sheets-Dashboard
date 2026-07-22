"use client";

import { createContext, useContext, useState, useRef, useCallback, useEffect } from "react";
import { mutate as globalMutate } from "swr";
import { readPanelLS, writePanelLS, fetchJsonWithRetry, type BulkPanel } from "@/lib/panel-runs";
import { useBuyQueue } from "@/lib/hooks/use-buy-queue";

// Owns the Domains-page bulk-op progress panels (persist across tab switches +
// refresh, auto-retry, manual Retry, never stuck) + the purchase-success panel.
// Mounted above the tabs so its panels render page-wide.

const BATCH = 6;

interface DomainOpsValue {
  panels: BulkPanel[];
  runAutoRenew: (domains: string[], enabled: boolean) => void;
  runHide: (domains: string[], hidden: boolean) => void;
  runSurbl: (domains: string[]) => void;
  runSpamhaus: (domains: string[]) => void;
  dismiss: (id: number) => void;
  dismissAll: () => void;
  purchaseNotice: { count: number } | null;
  dismissPurchase: () => void;
}

const Ctx = createContext<DomainOpsValue | null>(null);
export function useDomainOps(): DomainOpsValue {
  const c = useContext(Ctx);
  if (!c) throw new Error("useDomainOps must be used within DomainOpsProvider");
  return c;
}

export function DomainOpsProvider({ children }: { children: React.ReactNode }) {
  const rawRef = useRef<BulkPanel[] | null>(null);
  const [panels, setPanels] = useState<BulkPanel[]>(() => {
    const saved = readPanelLS<BulkPanel[]>("panels") || [];
    rawRef.current = saved;
    // An interrupted run (running/queued when the page died) is shown as
    // finished; anything unfinished is offered via Retry.
    return saved.map((p) =>
      p.running || p.queued
        ? { ...p, running: false, queued: false, retryDomains: Array.from(new Set([...(p.retryDomains || [])])) }
        : p,
    );
  });
  useEffect(() => { writePanelLS("panels", panels); }, [panels]);

  const runIdRef = useRef(1);
  const dismissedRef = useRef<Set<number>>(new Set());
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = useCallback((fn: () => Promise<void>) => {
    const run = queueRef.current.then(fn, fn);
    queueRef.current = run.then(() => undefined, () => undefined);
    return run;
  }, []);

  useEffect(() => {
    let max = 0;
    for (const p of rawRef.current || []) if (p.id > max) max = p.id;
    if (runIdRef.current <= max) runIdRef.current = max + 1;
  }, []);

  const replacePanel = useCallback((panel: BulkPanel) => {
    setPanels((prev) => [...prev.filter((p) => p.kind !== panel.kind), panel]);
  }, []);
  const patchPanel = useCallback((id: number, patch: Partial<BulkPanel>) => {
    setPanels((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  // Generic batched+retried driver for every domain bulk op. Each route returns
  // { results: [{ domain, status: "ok"|"failed", error? }] }.
  const runBulk = useCallback((opts: {
    kind: BulkPanel["kind"];
    title: string;
    url: string;
    body: (batch: string[]) => Record<string, unknown>;
    domains: string[];
    enabled?: boolean;
    batchSize?: number;
  }) => {
    const list = Array.from(new Set(opts.domains.map((d) => d.trim().toLowerCase()).filter(Boolean)));
    if (list.length === 0) return;
    const step = opts.batchSize ?? BATCH;
    const id = runIdRef.current++;
    replacePanel({
      id, kind: opts.kind, title: opts.title,
      total: list.length, done: 0, failed: 0, running: false, queued: true, failures: [], retryDomains: [], enabled: opts.enabled,
    });
    enqueue(async () => {
      if (dismissedRef.current.has(id)) return;
      patchPanel(id, { queued: false, running: true });
      const failures: { domain: string; error: string }[] = [];
      const retry: string[] = [];
      let done = 0, failed = 0;
      try {
        for (let i = 0; i < list.length; i += step) {
          if (dismissedRef.current.has(id)) break;
          const batch = list.slice(i, i + step);
          const rr = await fetchJsonWithRetry<{ results?: { domain: string; status: string; error?: string }[] }>(opts.url, opts.body(batch));
          if (!rr.ok || !rr.data) {
            for (const d of batch) { failed++; failures.push({ domain: d, error: rr.error || "request failed" }); retry.push(d); }
          } else {
            for (const r of rr.data.results || []) {
              if (r.status === "ok") done++;
              else { failed++; failures.push({ domain: r.domain, error: r.error || "failed" }); retry.push(r.domain); }
            }
          }
          patchPanel(id, { done, failed, failures: [...failures] });
        }
      } finally {
        patchPanel(id, { running: false, queued: false, retryDomains: Array.from(new Set(retry)) });
        globalMutate("/api/domains/inventory/list");
        globalMutate("/api/domains/purchased");
        globalMutate("/api/domains/list");
      }
    });
  }, [enqueue, replacePanel, patchPanel]);

  const runAutoRenew = useCallback((domains: string[], enabled: boolean) =>
    runBulk({ kind: "auto-renew", title: `Auto-renew ${enabled ? "ON" : "OFF"}`, url: "/api/domains/inventory/auto-renew", body: (b) => ({ domains: b, enabled }), domains, enabled, batchSize: 6 }),
  [runBulk]);

  const runHide = useCallback((domains: string[], hidden: boolean) =>
    runBulk({ kind: "hide", title: hidden ? "Hide domains" : "Unhide domains", url: "/api/domains/inventory/hide", body: (b) => ({ domains: b, hidden }), domains, enabled: hidden, batchSize: 200 }),
  [runBulk]);

  const runSurbl = useCallback((domains: string[]) =>
    runBulk({ kind: "surbl", title: "SURBL check", url: "/api/domains/blacklist-check", body: (b) => ({ domains: b }), domains, batchSize: 200 }),
  [runBulk]);

  const runSpamhaus = useCallback((domains: string[]) =>
    runBulk({ kind: "spamhaus", title: "Spamhaus check", url: "/api/domains/spamhaus-check", body: (b) => ({ domains: b }), domains, batchSize: 200 }),
  [runBulk]);

  const dismiss = useCallback((id: number) => {
    dismissedRef.current.add(id);
    setPanels((prev) => prev.filter((p) => p.id !== id));
  }, []);
  const dismissAll = useCallback(() => {
    setPanels((prev) => { prev.forEach((p) => dismissedRef.current.add(p.id)); return []; });
  }, []);

  // ── Purchase-success panel ──────────────────────────────────────────────
  const { counts: queueCounts, isLoading: queueLoading } = useBuyQueue(30000);
  const registered = queueCounts.registered ?? 0;
  const [baseline, setBaseline] = useState<number>(() => {
    const b = readPanelLS<number>("purchaseBaseline");
    return typeof b === "number" ? b : -1;
  });
  useEffect(() => {
    if (baseline < 0 && !queueLoading) { setBaseline(registered); writePanelLS("purchaseBaseline", registered); }
  }, [baseline, queueLoading, registered]);
  const purchaseNotice = baseline >= 0 && registered > baseline ? { count: registered - baseline } : null;
  const dismissPurchase = useCallback(() => {
    setBaseline(registered);
    writePanelLS("purchaseBaseline", registered);
  }, [registered]);

  return (
    <Ctx.Provider value={{ panels, runAutoRenew, runHide, runSurbl, runSpamhaus, dismiss, dismissAll, purchaseNotice, dismissPurchase }}>
      {children}
    </Ctx.Provider>
  );
}
