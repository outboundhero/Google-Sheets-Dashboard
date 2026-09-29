"use client";

import useSWR from "swr";
import type { InboxOrderBatch } from "@/lib/inbox-order-batches";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

/** Pass `null` to pause fetching (e.g. while the per-domain view is showing). */
export function useInboxOrderBatches(instancesQuery: string | null, refreshIntervalMs: number = 60_000) {
  const url = instancesQuery === null
    ? null
    : instancesQuery ? `/api/inbox-orders/batches?${instancesQuery}` : "/api/inbox-orders/batches";
  const { data, error, isLoading, mutate } = useSWR<{ batches?: InboxOrderBatch[]; generatedAt?: string; error?: string }>(
    url,
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 5000,
      refreshInterval: refreshIntervalMs,
      keepPreviousData: true,
    }
  );

  return {
    batches: data?.batches || [],
    generatedAt: data?.generatedAt ?? null,
    error: data?.error ?? (error ? String(error) : null),
    isLoading,
    mutate,
  };
}
