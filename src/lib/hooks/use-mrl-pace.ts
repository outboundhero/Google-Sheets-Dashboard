"use client";

import useSWR from "swr";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export interface MrlPaceClient {
  clientTag: string;
  companyName: string;
  plan: string;
  threshold: number;
  cycleStart: string;
  cycleEnd: string;
  cycleLength: number;
  daysElapsed: number;
  daysRemaining: number;
  actualMrls: number;
  expectedMrlsToDate: number;
  paceRatio: number;
  velocity7d: number;
  projectedTotal: number;
  priorCycleActualAtSameDay: number | null;
  severity: "at_risk" | "critical";
  rootCauseHint: string;
  signals: {
    leadsInPipeline: number;
    healthyDomains: number;
    flaggedDomains: number;
  };
}

interface MrlPaceResponse {
  flagged: MrlPaceClient[];
  evaluatedAt: string | null;
}

/** Clients currently off-pace for their MRL threshold (At Risk / Critical),
 *  worst first. Recomputed by the mrl-pace-check cron every 4 hours. */
export function useMrlPace() {
  const { data, error, isLoading, mutate } = useSWR<MrlPaceResponse>(
    "/api/mrl-pace-status",
    fetcher,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      revalidateIfStale: false,
      dedupingInterval: 10_000,
      refreshInterval: 5 * 60 * 1000,
      keepPreviousData: true,
    },
  );

  return {
    flagged: data?.flagged ?? [],
    evaluatedAt: data?.evaluatedAt ?? null,
    isLoading,
    error,
    mutate,
  };
}
