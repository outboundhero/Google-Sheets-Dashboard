"use client";

import useSWR from "swr";

export interface DiscoveredDomain {
  domain: string;
  price_usd: number;
  regular_price_usd: number | null;
  niche: string;
  discovered_at: string;
  registered: boolean;
  registered_at: string | null;
  auto_renew_disabled: boolean;
  appended_to_sheet: boolean;
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function useDomains(refreshIntervalMs: number = 0) {
  const { data, error, isLoading, mutate } = useSWR<{ domains: DiscoveredDomain[] }>(
    "/api/domains/list",
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 5000,
      refreshInterval: refreshIntervalMs,
      keepPreviousData: true,
    }
  );

  return {
    domains: data?.domains || [],
    isLoading,
    error,
    mutate,
  };
}
