"use client";

import useSWR from "swr";

export interface OffboardTagStatus {
  activeCampaigns: number;
  taggedDomains: number;
  decision: string | null;
  done: boolean;
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

/** Per churned-client-tag offboarding completeness (grey "Done" vs yellow
 *  "action needed" on the Churned clients card). Keyed by UPPERCASE tag. */
export function useOffboardingStatus() {
  const { data, mutate, isLoading } = useSWR<{ status: Record<string, OffboardTagStatus> }>(
    "/api/churn-offboarding/status",
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 60_000 },
  );
  return { statusByTag: data?.status || {}, mutate, isLoading };
}
