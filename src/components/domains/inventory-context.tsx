"use client";

import {
  createContext,
  useContext,
  useState,
  useRef,
  useCallback,
  useEffect,
} from "react";
import { mutate as globalMutate } from "swr";
import { useAuth } from "@/lib/auth-context";

// Holds the inventory sync + MX-resolve engine ABOVE the tabs so "Refresh
// Porkbun" keeps running (and shows progress) even when the user switches to
// the Buy tab. The All Domains table reads its data via SWR; this only owns the
// long-running actions + their progress.

interface InventoryContextValue {
  syncing: boolean;
  syncMsg: string | null;
  mxRemaining: number | null;
  mxRunning: boolean;
  mxResolved: number;
  mxFailed: number;
  mxNote: string | null;
  refreshPorkbun: () => Promise<void>;
  resolveProviders: () => void;
}

const InventoryContext = createContext<InventoryContextValue | null>(null);

export function useInventory(): InventoryContextValue {
  const ctx = useContext(InventoryContext);
  if (!ctx) throw new Error("useInventory must be used within InventoryProvider");
  return ctx;
}

export function InventoryProvider({ children }: { children: React.ReactNode }) {
  const { role } = useAuth();
  const isAdmin = role === "admin";

  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [mxRemaining, setMxRemaining] = useState<number | null>(null);
  const [mxRunning, setMxRunning] = useState(false);
  const [mxResolved, setMxResolved] = useState(0);
  const [mxFailed, setMxFailed] = useState(0);
  const [mxNote, setMxNote] = useState<string | null>(null);
  const mxRunningRef = useRef(false);

  const runMxLoop = useCallback(async () => {
    if (mxRunningRef.current) return;
    mxRunningRef.current = true;
    setMxRunning(true);
    setMxResolved(0);
    setMxFailed(0);
    setMxNote(null);
    let totalResolved = 0;
    let totalFailed = 0;
    try {
      for (let i = 0; i < 200; i++) {
        const res = await fetch("/api/domains/inventory/resolve-mx", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limit: 300 }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setMxNote(`Stopped: ${err?.error || `HTTP ${res.status}`}`);
          break;
        }
        const data = await res.json();
        totalResolved += data.resolved ?? 0;
        totalFailed += data.failed ?? 0;
        setMxResolved(totalResolved);
        setMxFailed(totalFailed);
        setMxRemaining(data.remaining ?? 0);
        await globalMutate("/api/domains/inventory/list");
        if ((data.processed ?? 0) === 0 || (data.remaining ?? 0) === 0) break;
        // A whole batch resolved nothing → the lookups are failing; stop and
        // surface why (a sample error) instead of spinning on the same rows.
        if ((data.resolved ?? 0) === 0) {
          const sampleErr = Array.isArray(data.sample) ? data.sample.find((s: { error?: string }) => s?.error)?.error : null;
          setMxNote(`Lookups failing — ${data.failed ?? 0} failed this batch${sampleErr ? ` · e.g. ${sampleErr}` : ""}`);
          break;
        }
      }
    } finally {
      mxRunningRef.current = false;
      setMxRunning(false);
    }
  }, []);

  // Kick a background provider-resolution pass on mount (admins only).
  useEffect(() => {
    if (isAdmin) runMxLoop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  const refreshPorkbun = useCallback(async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch("/api/domains/inventory/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      const parts = (data.accounts || []).map((a: { account: string; ok: boolean; count?: number; error?: string }) =>
        a.ok ? `${a.account}: ${a.count}` : `${a.account}: failed`
      );
      setSyncMsg(`Synced ${data.upserted} · pruned ${data.pruned} · ${parts.join(" · ")}`);
      await globalMutate("/api/domains/inventory/list");
      runMxLoop();
    } catch (e) {
      setSyncMsg(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }, [runMxLoop]);

  return (
    <InventoryContext.Provider value={{ syncing, syncMsg, mxRemaining, mxRunning, mxResolved, mxFailed, mxNote, refreshPorkbun, resolveProviders: runMxLoop }}>
      {children}
    </InventoryContext.Provider>
  );
}
