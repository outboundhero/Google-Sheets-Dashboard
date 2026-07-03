"use client";

import useSWR from "swr";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export interface ProviderStatusEntry {
  status: "active" | "canceled";
  raw_status: string | null;
  failure_reason: string | null;
  checked_at: string;
  provider: string;
}

interface ProviderStatusResponse {
  statuses: Record<string, ProviderStatusEntry>;
}

/**
 * Wraps /api/deliverability/provider-status, returning a keyed map by
 * "instance:domain". Populated by the daily provider-domain-status cron;
 * the map is used to render the Provider column + drive the filter chip
 * on the Deliverability page.
 */
export function useProviderStatus(instancesQuery: string) {
  const url = `/api/deliverability/provider-status?${instancesQuery}`;
  const { data, error, isLoading, isValidating, mutate } = useSWR<ProviderStatusResponse>(
    url,
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
    statuses: data?.statuses ?? {},
    isLoading,
    isValidating,
    error,
    mutate,
  };
}
