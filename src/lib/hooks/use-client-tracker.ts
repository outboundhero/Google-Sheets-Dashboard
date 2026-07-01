"use client";

import useSWR from "swr";
import type { ClientTrackerRow } from "@/lib/google-sheets";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function useClientTracker() {
  const { data, error, isLoading, mutate } = useSWR<ClientTrackerRow[]>(
    "/api/client-tracker",
    fetcher,
    {
      // Sheet edits should show up when the user comes back to the tab or
      // reconnects — not 30 min later. 2-min dedupe keeps concurrent hits on
      // the same page cheap without pinning users to stale data.
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      dedupingInterval: 2 * 60 * 1000,
    },
  );

  /** Force a fresh read of the Client Tracker sheet — busts both the server-side
   *  in-memory cache and the SWR cache. Used by the "refresh" buttons on the
   *  dashboard cards. */
  async function refresh(): Promise<void> {
    const res = await fetch("/api/client-tracker?refresh=1", { cache: "no-store" });
    const fresh = (await res.json()) as ClientTrackerRow[];
    await mutate(fresh, { revalidate: false });
  }

  return {
    clients: data || [],
    isLoading,
    error,
    refresh,
  };
}
