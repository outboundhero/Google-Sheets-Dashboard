"use client";

import useSWR from "swr";

export interface BuyQueueRow {
  domain: string;
  status: "queued" | "buying" | "registered" | "failed" | "skipped";
  real_price_usd: number | string | null;
  purchased_at: string | null;
  last_error: string | null;
  requested_at: string;
  updated_at: string;
}

export interface BuyQueueData {
  counts: Record<string, number>;
  lastPurchaseAt: string | null;
  nextEligibleAt: string | null;
  inWindow: boolean;
  recent: BuyQueueRow[];
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function useBuyQueue(refreshIntervalMs = 15000) {
  const { data, error, isLoading, mutate } = useSWR<BuyQueueData>(
    "/api/domains/queue",
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 5000,
      refreshInterval: refreshIntervalMs,
      keepPreviousData: true,
    }
  );

  return {
    counts: data?.counts || {},
    lastPurchaseAt: data?.lastPurchaseAt ?? null,
    nextEligibleAt: data?.nextEligibleAt ?? null,
    inWindow: data?.inWindow ?? false,
    recent: data?.recent || [],
    isLoading,
    error,
    mutate,
  };
}
