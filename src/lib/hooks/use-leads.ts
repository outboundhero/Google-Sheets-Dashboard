"use client";

import useSWR from "swr";
import type { Lead } from "@/types/lead";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function useAllLeads() {
  const { data, error, isLoading, isValidating, mutate } = useSWR<Lead[]>(
    "/api/data/all",
    fetcher,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 10000, // Dedupe requests within 10 seconds
      refreshInterval: 5 * 60 * 1000, // Auto-refresh every 5 minutes
      keepPreviousData: true, // Keep showing previous data during revalidation (prevents flickering!)
    }
  );

  return {
    leads: data || [],
    isLoading,
    isValidating,
    error,
    refresh: async () => {
      // Sync all sheets in chunks (20 per call) to respect Google API rate limits
      let offset = 0;
      let complete = false;
      while (!complete) {
        const res = await fetch(`/api/sync?offset=${offset}`, { method: "POST" });
        const data = await res.json();
        complete = data.complete;
        offset = data.nextOffset || 0;
      }
      return mutate();
    },
  };
}

export function useSheetLeads(sheetId: string | null) {
  const { data, error, isLoading, isValidating, mutate } = useSWR(
    sheetId ? `/api/sheets/${sheetId}` : null,
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
    sheet: data?.sheet,
    leads: (data?.leads || []) as Lead[],
    isLoading,
    isValidating,
    error,
    mutate,
  };
}
