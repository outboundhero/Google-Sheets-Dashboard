"use client";

import useSWR from "swr";
import type { DashboardAnalytics } from "@/types/analytics";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function useAnalytics(client?: string) {
  const url = client
    ? `/api/analytics?client=${encodeURIComponent(client)}`
    : "/api/analytics";

  const { data, error, isLoading, isValidating, mutate } = useSWR<DashboardAnalytics>(
    url,
    fetcher,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      revalidateIfStale: false,
      dedupingInterval: 10000, // Dedupe requests within 10 seconds
      refreshInterval: 5 * 60 * 1000, // Auto-refresh every 5 minutes (matching useAllLeads)
      keepPreviousData: true, // Keep showing previous data during revalidation (prevents flickering!)
    }
  );

  return {
    analytics: data,
    isLoading,
    isValidating,
    error,
    mutate,
  };
}
