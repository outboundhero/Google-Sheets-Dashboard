"use client";

import useSWR from "swr";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export type TriageStatus = "unreviewed" | "in_progress" | "resolved";

export interface TriageEntry {
  status: TriageStatus;
  updated_by: string | null;
  updated_at: string;
}

interface TriageResponse {
  statuses: Record<string, TriageEntry>;
}

// Cycle order for clicking a tag.
export const TRIAGE_CYCLE: TriageStatus[] = ["unreviewed", "in_progress", "resolved"];
export function nextStatus(s: TriageStatus): TriageStatus {
  const i = TRIAGE_CYCLE.indexOf(s);
  return TRIAGE_CYCLE[(i + 1) % TRIAGE_CYCLE.length];
}

/**
 * Shared triage statuses for the stale-clients panel.
 * Pass the CURRENT panel tags — the API uses them to auto-reset clients that
 * have dropped off the panel. Polls every 15s so both users stay in sync.
 */
export function useTriageStatus(tags: string[]) {
  const sorted = [...tags].sort();
  const key = `/api/triage-status?tags=${encodeURIComponent(sorted.join(","))}`;
  const { data, mutate, isLoading } = useSWR<TriageResponse>(key, fetcher, {
    revalidateOnFocus: true,
    refreshInterval: 15000,
    dedupingInterval: 5000,
    keepPreviousData: true,
  });

  const statuses = data?.statuses || {};

  async function setStatus(clientTag: string, status: TriageStatus, updatedBy: string | null) {
    // Optimistic update, then POST, then revalidate.
    await mutate(async () => {
      await fetch("/api/triage-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientTag, status, updatedBy }),
      });
      const res = await fetch(key);
      return res.json();
    }, {
      optimisticData: {
        statuses: { ...statuses, [clientTag]: { status, updated_by: updatedBy, updated_at: new Date().toISOString() } },
      },
      rollbackOnError: true,
      revalidate: false,
    });
  }

  return { statuses, setStatus, isLoading };
}
