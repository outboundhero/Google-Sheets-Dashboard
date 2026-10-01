"use client";

import useSWR from "swr";
import type { PerformanceClient } from "@/app/api/performance/route";
import type { SendingWindow } from "@/lib/sending-mode/windows";
import type { SendingModeSettings } from "@/lib/sending-mode/config";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface PerformanceResponse {
  clients: PerformanceClient[];
  windows: SendingWindow[];
  settings: SendingModeSettings;
  evaluatedAt: string | null;
  error?: string;
}

export type { PerformanceClient, SendingWindow, SendingModeSettings };

export function usePerformance() {
  const { data, error, isLoading, mutate } = useSWR<PerformanceResponse>("/api/performance", fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 10000,
    keepPreviousData: true,
  });
  return {
    clients: data?.clients ?? [],
    windows: data?.windows ?? [],
    settings: data?.settings ?? null,
    evaluatedAt: data?.evaluatedAt ?? null,
    error: error || (data?.error ? new Error(data.error) : null),
    isLoading,
    mutate,
  };
}
