"use client";

import useSWR from "swr";
import type { TrackedSheet } from "@/types/sheet";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function useSheets() {
  const { data, error, isLoading, mutate } = useSWR<TrackedSheet[]>(
    "/api/sheets",
    fetcher,
    { revalidateOnFocus: false }
  );

  return {
    sheets: data || [],
    isLoading,
    error,
    mutate,
  };
}
