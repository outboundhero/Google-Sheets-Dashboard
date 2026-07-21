"use client";

import useSWR from "swr";
import type { PurchasedRow } from "@/app/api/domains/purchased/route";

export type { PurchasedRow };

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function usePurchasedDomains() {
  const { data, error, isLoading, mutate } = useSWR<{
    rows: PurchasedRow[];
    counts: { total: number; totalSpent: number };
  }>("/api/domains/purchased", fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 10000,
    keepPreviousData: true,
  });

  return {
    rows: data?.rows || [],
    counts: data?.counts,
    isLoading,
    error,
    mutate,
  };
}
