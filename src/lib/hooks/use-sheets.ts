"use client";

import useSWR from "swr";
import type { TrackedSheet } from "@/types/sheet";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function useSheets() {
  const { data, error, isLoading, isValidating, mutate } = useSWR<TrackedSheet[]>(
    "/api/sheets",
    fetcher,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      revalidateIfStale: false,
      dedupingInterval: 60000, // Dedupe requests within 1 minute
      refreshInterval: 5 * 60 * 1000, // Auto-refresh every 5 minutes
      keepPreviousData: true, // Keep showing previous data during revalidation
    }
  );

  return {
    sheets: data || [],
    isLoading,
    isValidating,
    error,
    mutate,
  };
}
