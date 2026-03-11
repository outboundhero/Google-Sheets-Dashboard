"use client";

import useSWR from "swr";
import type { ClientTrackerRow } from "@/lib/google-sheets";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function useClientTracker() {
  const { data, error, isLoading } = useSWR<ClientTrackerRow[]>(
    "/api/client-tracker",
    fetcher,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 30 * 60 * 1000,
    }
  );

  return {
    clients: data || [],
    isLoading,
    error,
  };
}
