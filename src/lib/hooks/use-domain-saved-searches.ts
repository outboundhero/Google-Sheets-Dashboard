"use client";

import useSWR from "swr";

export interface SavedSearch {
  id: number;
  name: string;
  filter: Record<string, unknown>;
  updatedAt: string;
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function useDomainSavedSearches(scope: "all-domains" | "purchased") {
  const { data, error, isLoading, mutate } = useSWR<{ searches: SavedSearch[] }>(
    `/api/domains/saved-searches?scope=${scope}`,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 10000, keepPreviousData: true },
  );
  return { searches: data?.searches || [], isLoading, error, mutate };
}
