"use client";

import useSWR from "swr";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export type TriageStatus = "unreviewed" | "in_progress" | "resolved";

export interface TriageEntry {
  status: TriageStatus;
  needs: string[];
  resolve_reason: string | null;
  resolve_fixed: string | null;
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
export function useTriageStatus(tags: string[], ready = true) {
  const sorted = [...tags].sort();
  // IMPORTANT: only send the `tags` param once the panel data has actually
  // loaded. The API prunes (and, on an empty list, RESETS ALL) statuses based
  // on this param — during the brief load on a refresh `tags` is [], which
  // would wipe every status (the "resets on refresh" bug). Until ready, read
  // without `tags` so the server just returns stored statuses without pruning.
  const key = ready
    ? `/api/triage-status?tags=${encodeURIComponent(sorted.join(","))}`
    : `/api/triage-status`;
  const { data, mutate, isLoading } = useSWR<TriageResponse>(key, fetcher, {
    revalidateOnFocus: true,
    refreshInterval: 15000,
    dedupingInterval: 5000,
    keepPreviousData: true,
  });

  const statuses = data?.statuses || {};

  // Shared optimistic-POST helper. `patch` is the field(s) being changed; the
  // entry's other fields are preserved from the current cache.
  async function update(
    clientTag: string,
    body: { status?: TriageStatus; needs?: string[]; reason?: string; fixed?: string },
    updatedBy: string | null,
  ) {
    const prev = statuses[clientTag] ?? { status: "unreviewed" as TriageStatus, needs: [], resolve_reason: null, resolve_fixed: null, updated_by: null, updated_at: "" };
    // Optimistically mirror the diagnosis onto the entry (the POST stores it).
    const optimisticDiag = body.status === "resolved"
      ? { needs: body.needs ?? prev.needs, resolve_reason: body.reason?.trim() || null, resolve_fixed: body.fixed?.trim() || null }
      : {};
    await mutate(async () => {
      await fetch("/api/triage-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientTag, ...body, updatedBy }),
      });
      const res = await fetch(key);
      return res.json();
    }, {
      optimisticData: {
        statuses: {
          ...statuses,
          [clientTag]: { ...prev, ...body, ...optimisticDiag, updated_by: updatedBy, updated_at: new Date().toISOString() },
        },
      },
      rollbackOnError: true,
      revalidate: false,
    });
  }

  function setStatus(
    clientTag: string,
    status: TriageStatus,
    updatedBy: string | null,
    diagnosis?: { needs?: string[]; reason?: string; fixed?: string },
  ) {
    return update(clientTag, { status, ...diagnosis }, updatedBy);
  }

  return { statuses, setStatus, isLoading };
}
