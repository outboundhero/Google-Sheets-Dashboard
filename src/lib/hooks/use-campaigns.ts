"use client";

import useSWR from "swr";
import type { CampaignData } from "@/app/api/campaigns/route";

export type { CampaignData };

const fetcher = (url: string) => fetch(url).then((r) => r.json());

/** Master-grid campaigns: all campaigns across the selected instances (not
 *  active-client-filtered), enriched with stage/classification/group/tier. */
export function useCampaigns(instancesQuery: string) {
  const { data, error, isLoading, mutate } = useSWR<{ campaigns: CampaignData[]; activeClients: string[]; churnedClients?: string[] }>(
    `/api/campaigns?all=1&${instancesQuery}`,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 10000, keepPreviousData: true },
  );
  return {
    campaigns: Array.isArray(data?.campaigns) ? data.campaigns : [],
    activeClients: Array.isArray(data?.activeClients) ? data.activeClients : [],
    churnedClients: Array.isArray(data?.churnedClients) ? data.churnedClients : [],
    isLoading,
    error,
    mutate,
  };
}
