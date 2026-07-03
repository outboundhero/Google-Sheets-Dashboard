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
  bizDaysTotal: number;
  bizDaysElapsed: number;
  bizDaysRemaining: number;
  actualMrls: number;
  expectedMrlsToDate: number;
  pctBehind: number;
  velocity7d: number;
  maxVelocity7d: number;
  velocityDaily: number[];
  projectedTotal: number;
  priorCycleActualAtSameDay: number | null;
  priorCycleTotal: number | null;
  isFirstCycle: boolean;
  historicallyRecovers: boolean;
  severity: "critical" | "at_risk" | "on_track";
  rootCauseTag: string;
  rootCauseDetail: string | null;
  rootCauseConfidence: "high" | "medium" | null;
  daysInSeverity: number | null;
  dayNCritical: number | null;
  signals: {
    leadsInPipeline: number;
    totalContacts: number;
    healthyAccounts: number;
    totalAccounts: number;
    nurtureCampaigns: number;
    failedCampaigns: number;
  };
}

interface MrlPaceResponse {
  clients: MrlPaceClient[];
  evaluatedAt: string | null;
}

/** All evaluated clients (three tiers), sorted critical → at_risk → on_track,
 *  worst pace-gap first within tier. Recomputed daily by mrl-pace-check. */
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
    clients: data?.clients ?? [],
    evaluatedAt: data?.evaluatedAt ?? null,
    isLoading,
    error,
    mutate,
  };
}
