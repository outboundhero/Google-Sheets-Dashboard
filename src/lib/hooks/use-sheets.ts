"use client";

import useSWR from "swr";
import type { TrackedSheet } from "@/types/sheet";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function useSheets() {
  const { data, error, isLoading, mutate } = useSWR<TrackedSheet[]>(
    "/api/sheets",
    fetcher,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      revalidateIfStale: false,
      dedupingInterval: 60000, // Dedupe requests within 1 minute
      keepPreviousData: true, // Keep showing previous data during revalidation
    }
  );

  return {
    sheets: data || [],
    isLoading,
    error,
    mutate,
  };
}
