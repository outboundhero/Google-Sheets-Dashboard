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
      // Trigger full sync from Google Sheets → Redis
      const res = await fetch("/api/sync", { method: "POST" });
      if (res.status === 409) {
        // Sync already in progress — wait for it to finish, then refresh
        await new Promise((r) => setTimeout(r, 10000));
      }
      // Revalidate SWR with fresh data from Redis
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
