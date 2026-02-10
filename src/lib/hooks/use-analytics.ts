"use client";

import useSWR from "swr";
import type { DashboardAnalytics } from "@/types/analytics";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function useAnalytics(client?: string) {
  const url = client
    ? `/api/analytics?client=${encodeURIComponent(client)}`
    : "/api/analytics";

  const { data, error, isLoading, mutate } = useSWR<DashboardAnalytics>(
    url,
    fetcher,
    { revalidateOnFocus: false, refreshInterval: 5 * 60 * 1000 }
  );

  return {
    analytics: data,
    isLoading,
    error,
    mutate,
  };
}
