"use client";

import useSWR from "swr";
import type { Lead } from "@/types/lead";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function useAllLeads() {
  const { data, error, isLoading, mutate } = useSWR<Lead[]>(
    "/api/data/all",
    fetcher,
    { revalidateOnFocus: false, refreshInterval: 5 * 60 * 1000 }
  );

  return {
    leads: data || [],
    isLoading,
    error,
    mutate,
  };
}

export function useSheetLeads(sheetId: string | null) {
  const { data, error, isLoading, mutate } = useSWR(
    sheetId ? `/api/sheets/${sheetId}` : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  return {
    sheet: data?.sheet,
    leads: (data?.leads || []) as Lead[],
    isLoading,
    error,
    mutate,
  };
}
