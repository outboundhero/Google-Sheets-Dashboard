"use client";

import useSWR from "swr";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface DomainInstancesResponse {
  map: Record<string, BisonInstanceSlug[]>;
  created?: Record<string, Record<string, string | null>>;
  inboxes?: Record<string, Record<string, number>>;
}

/**
 * Wraps /api/deliverability/domain-instances: which Bison instance(s) each
 * domain exists in, across all 4 instances (not scoped by the sidebar
 * switcher). Powers the Instances column + "Exists in instance" filter on
 * the Deliverability page.
 */
export function useDomainInstances() {
  const { data, error, isLoading, mutate } = useSWR<DomainInstancesResponse>(
    "/api/deliverability/domain-instances",
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
    domainInstancesMap: data?.map ?? {},
    domainCreatedMap: data?.created ?? {},
    domainInboxesMap: data?.inboxes ?? {},
    isLoading,
    error,
    mutate,
  };
}
