"use client";

import useSWR from "swr";
import type { CampaignData } from "@/app/api/campaigns/route";

export type { CampaignData };

const fetcher = (url: string) => fetch(url).then((r) => r.json());

/** Master-grid campaigns: all campaigns across the selected instances (not
 *  active-client-filtered), enriched with stage/classification/group/tier. */
export function useCampaigns(instancesQuery: string) {
  const { data, error, isLoading, mutate } = useSWR<{ campaigns: CampaignData[]; activeClients: string[] }>(
    `/api/campaigns?all=1&${instancesQuery}`,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 10000, keepPreviousData: true },
  );
  return {
    campaigns: data?.campaigns || [],
    activeClients: data?.activeClients || [],
    isLoading,
    error,
    mutate,
  };
}
