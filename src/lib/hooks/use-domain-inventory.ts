"use client";

import useSWR from "swr";
import type { InventoryRow, InventoryCounts } from "@/lib/domain-inventory";

export type { InventoryRow, InventoryCounts };

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function useDomainInventory() {
  const { data, error, isLoading, mutate } = useSWR<{
    rows: InventoryRow[];
    counts: InventoryCounts;
    generatedAt: string;
  }>("/api/domains/inventory/list", fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 10000,
    keepPreviousData: true,
  });

  return {
    rows: data?.rows || [],
    counts: data?.counts,
    generatedAt: data?.generatedAt,
    isLoading,
    error,
    mutate,
  };
}
