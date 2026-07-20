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

// Holds the domain-discovery engine ABOVE the tabs so the paced check loop keeps
// running when the user switches between the Buy and All Domains tabs. Both the
// Buy panel (full controls + detail) and the top progress banner consume this.

export const TICK_MS = 10_500;
export const TLDS = [".info", ".com", ".co", ".net", ".org"] as const;
export type Tld = (typeof TLDS)[number];

export type DiscoveryStatus = "idle" | "running" | "paused" | "complete" | "error";

export interface RecentResult {
  domain: string;
  outcome: "available" | "taken" | "error";
  price?: number;
  error?: string;
}

interface DiscoveryContextValue {
  // generation params
  mode: "niche" | "lookalike";
  setMode: (m: "niche" | "lookalike") => void;
  niche: string;
  setNiche: (n: string) => void;
  seedDomain: string;
  setSeedDomain: (s: string) => void;
  selectedTlds: Set<Tld>;
  toggleTld: (t: Tld) => void;
  count: number;
  setCount: (n: number) => void;
  // run state
  candidates: string[];
  cursor: number;
  status: DiscoveryStatus;
  error: string | null;
  recentResults: RecentResult[];
  counts: { available: number; taken: number; errors: number };
  skippedAlreadyChecked: number;
  generating: boolean;
  // derived
  total: number;
  checkedSoFar: number;
  progressPct: number;
  remainingMin: number;
  // actions
  startDiscovery: () => Promise<void>;
  pauseDiscovery: () => void;
  resumeDiscovery: () => void;
}

const DiscoveryContext = createContext<DiscoveryContextValue | null>(null);

export function useDiscovery(): DiscoveryContextValue {
  const ctx = useContext(DiscoveryContext);
  if (!ctx) throw new Error("useDiscovery must be used within DiscoveryProvider");
  return ctx;
}

export function DiscoveryProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<"niche" | "lookalike">("niche");
  const [niche, setNiche] = useState("commercial cleaning");
  const [seedDomain, setSeedDomain] = useState("");
  const [selectedTlds, setSelectedTlds] = useState<Set<Tld>>(new Set([".info"]));
  const [count, setCount] = useState(80);

  const [candidates, setCandidates] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [status, setStatus] = useState<DiscoveryStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [skippedAlreadyChecked, setSkippedAlreadyChecked] = useState(0);
  const [recentResults, setRecentResults] = useState<RecentResult[]>([]);
  const [counts, setCounts] = useState({ available: 0, taken: 0, errors: 0 });
  const [generating, setGenerating] = useState(false);
  const tickAbortRef = useRef<{ cancelled: boolean }>({ cancelled: false });

  const toggleTld = useCallback((t: Tld) => {
    setSelectedTlds((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      if (next.size === 0) next.add(".info");
      return next;
    });
  }, []);

  // Paced check loop — lives here (above the tabs) so tab switches don't kill it.
  useEffect(() => {
    if (status !== "running") return;
    if (cursor >= candidates.length) {
      setStatus("complete");
      globalMutate("/api/domains/list");
      return;
    }

    const abortRef = tickAbortRef.current;
    abortRef.cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const runOne = async () => {
      const domain = candidates[cursor];
      const t0 = Date.now();
      let outcome: RecentResult["outcome"] = "error";
      let price: number | undefined;
      let err: string | undefined;
      try {
        const res = await fetch("/api/domains/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domain, niche: mode === "lookalike" ? `look-a-like: ${seedDomain}` : niche }),
        });
        const data = await res.json();
        if (abortRef.cancelled) return;
        if (!res.ok) {
          err = data?.error || `HTTP ${res.status}`;
          outcome = "error";
        } else if (!data.available) {
          outcome = "taken";
        } else {
          outcome = "available";
          price = data.price;
        }
      } catch (e) {
        if (abortRef.cancelled) return;
        err = e instanceof Error ? e.message : "Network error";
        outcome = "error";
      }

      setRecentResults((prev) => [{ domain, outcome, price, error: err }, ...prev].slice(0, 12));
      setCounts((c) => ({
        available: c.available + (outcome === "available" ? 1 : 0),
        taken: c.taken + (outcome === "taken" ? 1 : 0),
        errors: c.errors + (outcome === "error" ? 1 : 0),
      }));
      if (outcome === "available") globalMutate("/api/domains/list");

      if (abortRef.cancelled) return;
      const elapsed = Date.now() - t0;
      const wait = Math.max(0, TICK_MS - elapsed);
      timer = setTimeout(() => {
        if (!abortRef.cancelled) setCursor((c) => c + 1);
      }, wait);
    };

    runOne();
    return () => {
      abortRef.cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [status, cursor, candidates, mode, niche, seedDomain]);

  const startDiscovery = useCallback(async () => {
    setError(null);
    setGenerating(true);
    try {
      const res = await fetch("/api/domains/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, tlds: Array.from(selectedTlds), niche, seedDomain, count }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      const fresh: string[] = Array.isArray(data.candidates) ? data.candidates : [];
      setCandidates(fresh);
      setCursor(0);
      setRecentResults([]);
      setCounts({ available: 0, taken: 0, errors: 0 });
      setSkippedAlreadyChecked(typeof data.skippedAlreadyChecked === "number" ? data.skippedAlreadyChecked : 0);
      setStatus(fresh.length === 0 ? "complete" : "running");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate candidates");
      setStatus("error");
    } finally {
      setGenerating(false);
    }
  }, [mode, selectedTlds, niche, seedDomain, count]);

  const pauseDiscovery = useCallback(() => {
    tickAbortRef.current.cancelled = true;
    setStatus("paused");
  }, []);
  const resumeDiscovery = useCallback(() => setStatus("running"), []);

  const total = candidates.length;
  const checkedSoFar = cursor;
  const progressPct = total > 0 ? Math.min(100, (checkedSoFar / total) * 100) : 0;
  const remainingMin = Math.ceil(((total - checkedSoFar) * TICK_MS) / 60000);

  const value: DiscoveryContextValue = {
    mode, setMode, niche, setNiche, seedDomain, setSeedDomain, selectedTlds, toggleTld, count, setCount,
    candidates, cursor, status, error, recentResults, counts, skippedAlreadyChecked, generating,
    total, checkedSoFar, progressPct, remainingMin,
    startDiscovery, pauseDiscovery, resumeDiscovery,
  };

  return <DiscoveryContext.Provider value={value}>{children}</DiscoveryContext.Provider>;
}
