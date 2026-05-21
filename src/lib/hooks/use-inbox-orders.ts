"use client";

import useSWR from "swr";
import type { InboxOrder } from "@/types/inbox-order";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function useInboxOrders(refreshIntervalMs: number = 0, instancesQuery?: string) {
  const url = instancesQuery ? `/api/inbox-orders?${instancesQuery}` : "/api/inbox-orders";
  const { data, error, isLoading, mutate } = useSWR<{ orders: InboxOrder[] }>(
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
    orders: data?.orders || [],
    isLoading,
    error,
    mutate,
  };
}
