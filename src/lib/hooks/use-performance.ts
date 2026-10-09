"use client";

import useSWR from "swr";
import type { PerformanceClient } from "@/app/api/performance/route";
import type { SendingWindow } from "@/lib/sending-mode/windows";
import type { SendingModeSettings } from "@/lib/sending-mode/config";
import type { TurboPreview } from "@/lib/sending-mode/turbo-preview";
import type { ThrottlePreview } from "@/lib/sending-mode/throttle-preview";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface PerformanceResponse {
  clients: PerformanceClient[];
  windows: SendingWindow[];
  settings: SendingModeSettings;
  evaluatedAt: string | null;
  judgedAt: string | null;
  error?: string;
}

export type { PerformanceClient, SendingWindow, SendingModeSettings, TurboPreview, ThrottlePreview };

/** What the next auto-throttle pass would do. Fetched only while `enabled`. */
export function useThrottlePreview(enabled: boolean) {
  const { data, error, isLoading } = useSWR<ThrottlePreview & { error?: string }>(
    enabled ? "/api/performance/throttle-preview" : null,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 60000, keepPreviousData: true },
  );
  return {
    preview: data && !data.error ? data : null,
    error: error || (data?.error ? new Error(data.error) : null),
    isLoading,
  };
}

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
    judgedAt: data?.judgedAt ?? null,
    error: error || (data?.error ? new Error(data.error) : null),
    isLoading,
    mutate,
  };
}
