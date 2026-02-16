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
      revalidateIfStale: false,
      dedupingInterval: 60000, // Dedupe requests within 1 minute
      refreshInterval: 0, // Disable auto-refresh
      keepPreviousData: true, // Keep showing previous data during revalidation
    }
  );

  return {
    leads: data || [],
    isLoading,
    isValidating,
    error,
    mutate,
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
