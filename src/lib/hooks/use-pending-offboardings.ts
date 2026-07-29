"use client";

import useSWR from "swr";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export type OffboardingStatus = "pending" | "confirmed" | "skipped" | "auto_fired" | "failed";

export interface OffboardingItem {
  clientAbbr: string;
  companyName: string;
  churnDate: string;
  status: OffboardingStatus;
  groupHint: 1 | 2 | null;
  decidedBy: string | null;
  decidedAt: string | null;
  executedAt: string | null;
  result: {
    pausedCampaigns?: { instance: string; id: number; name: string }[];
    inboxesDetagged?: number;
    pauseFailures?: { instance: string; id: number; name: string; error: string }[];
    detagFailures?: { instance: string; inboxId: number; reason: string }[];
    errors?: string[];
  } | null;
  createdAt: string;
}

export function useOffboardings() {
  const { data, error, isLoading, mutate } = useSWR<{ items: OffboardingItem[] }>(
    "/api/churn-offboarding",
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 60_000,
    },
  );
  const items = data?.items || [];
  return {
    items,
    pending: items.filter((i) => i.status === "pending"),
    skipped: items.filter((i) => i.status === "skipped"),
    isLoading,
    error,
    mutate,
  };
}
