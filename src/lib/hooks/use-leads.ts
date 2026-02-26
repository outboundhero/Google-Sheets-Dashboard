"use client";

import { useState, useCallback } from "react";
import useSWR from "swr";
import type { Lead } from "@/types/lead";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export interface SyncProgress {
  synced: number;
  total: number;
  errors: number;
}

export function useAllLeads() {
  const { data, error, isLoading, isValidating, mutate } = useSWR<Lead[]>(
    "/api/data/all",
    fetcher,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 10000,
      refreshInterval: 5 * 60 * 1000,
      keepPreviousData: true,
    }
  );

  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);

  const refresh = useCallback(async () => {
    setIsSyncing(true);
    setSyncProgress({ synced: 0, total: 0, errors: 0 });

    try {
      let offset = 0;
      let complete = false;
      let totalSynced = 0;
      let totalErrors = 0;
      let totalSheets = 0;
      let retries = 0;
      let isFirstChunk = true;

      while (!complete) {
        try {
          // Wait between chunks to respect Google API rate limit (60/min)
          if (!isFirstChunk) {
            await new Promise((r) => setTimeout(r, 3000));
          }
          isFirstChunk = false;

          const res = await fetch(`/api/sync?offset=${offset}`, { method: "POST" });

          if (!res.ok) {
            retries++;
            if (retries > 3) break;
            offset += 10;
            continue;
          }

          retries = 0;
          const result = await res.json();
          totalSynced += result.sheetsSuccess || 0;
          totalErrors += result.sheetsError || 0;
          totalSheets = result.totalSheets || totalSheets;
          complete = result.complete;
          offset = result.nextOffset || 0;

          setSyncProgress({
            synced: totalSynced,
            total: totalSheets,
            errors: totalErrors,
          });
        } catch {
          retries++;
          if (retries > 3) break;
          offset += 10;
        }
      }

      await mutate();
    } finally {
      setIsSyncing(false);
      setTimeout(() => setSyncProgress(null), 5000);
    }
  }, [mutate]);

  return {
    leads: data || [],
    isLoading,
    isValidating,
    error,
    isSyncing,
    syncProgress,
    refresh,
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
      dedupingInterval: 60000,
      keepPreviousData: true,
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
