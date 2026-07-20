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
  refreshPorkbun: () => Promise<void>;
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
  const mxRunningRef = useRef(false);

  const runMxLoop = useCallback(async () => {
    if (mxRunningRef.current) return;
    mxRunningRef.current = true;
    setMxRunning(true);
    try {
      for (let i = 0; i < 200; i++) {
        const res = await fetch("/api/domains/inventory/resolve-mx", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limit: 500 }),
        });
        if (!res.ok) break;
        const data = await res.json();
        setMxRemaining(data.remaining ?? 0);
        if ((data.processed ?? 0) === 0 || (data.remaining ?? 0) === 0) break;
        await globalMutate("/api/domains/inventory/list");
      }
      await globalMutate("/api/domains/inventory/list");
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
    <InventoryContext.Provider value={{ syncing, syncMsg, mxRemaining, mxRunning, refreshPorkbun }}>
      {children}
    </InventoryContext.Provider>
  );
}
