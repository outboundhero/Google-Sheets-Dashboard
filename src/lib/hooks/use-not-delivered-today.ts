"use client";

import useSWR from "swr";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export interface NotDeliveredLead {
  email: string;
  name: string;
  company: string;
  replyTime: string;
  timeWeGotReply: string;
  sheetId: string;
  sheetName: string;
  sheetClientTag: string;
}

interface ClientResponse {
  leads: NotDeliveredLead[];
  count: number;
}

interface AggregateResponse {
  total: number;
  byClient: { clientTag: string; count: number }[];
}

export function useNotDeliveredToday(clientTag: string | null | undefined) {
  const key = clientTag ? `/api/leads/not-delivered-today?clientTag=${encodeURIComponent(clientTag)}` : null;
  const { data, error, isLoading, mutate } = useSWR<ClientResponse>(key, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 30000,
    keepPreviousData: true,
  });

  return {
    leads: data?.leads || [],
    count: data?.count || 0,
    isLoading,
    error,
    mutate,
  };
}

export function useNotDeliveredTodayAggregate() {
  const { data, error, isLoading, mutate } = useSWR<AggregateResponse>(
    "/api/leads/not-delivered-today",
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 30000,
      keepPreviousData: true,
    },
  );

  return {
    total: data?.total || 0,
    byClient: data?.byClient || [],
    isLoading,
    error,
    mutate,
  };
}
