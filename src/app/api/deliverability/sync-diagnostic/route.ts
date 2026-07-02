import { NextResponse } from "next/server";
import { bisonFetch, resolveInstance } from "@/lib/bison";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

export const maxDuration = 60;

/**
 * GET /api/deliverability/sync-diagnostic?instance=<slug>&pages=3
 *
 * One-shot probe to answer: can we split /sender-emails into disjoint
 * cursor-paginated chains by `?status=<X>` and walk them in parallel to
 * beat cursor's per-chain sequential ceiling?
 *
 * Approach:
 *   1. Walk N pages of the base cursor endpoint. Collect (id → status) for
 *      each observed sender so we have ground-truth statuses.
 *   2. For each distinct status observed, hit /sender-emails?status=<X> and
 *      verify:
 *        a) the endpoint accepts the param (no 4xx / meaningful response)
 *        b) EVERY returned sender's status matches the requested value (i.e.
 *           the API is actually filtering, not silently ignoring the param)
 *        c) count of unique IDs across all filtered walks equals the base
 *           walk's count within the same page budget (i.e. coverage)
 *   3. Also cross-check disjointness: no sender ID appears under two different
 *      status filter walks.
 *
 * Read-only. Admin-gated via middleware because the base path is
 * /api/deliverability/*. Doesn't touch Supabase.
 */

interface SenderPeek {
  id: number;
  status: string;
}

async function walkPages(
  instance: BisonInstanceSlug,
  extraQs: string,
  maxPages: number,
): Promise<{ senders: SenderPeek[]; pagesWalked: number; okStatus: number | null }> {
  const senders: SenderPeek[] = [];
  let cursor: string | null = null;
  let pagesWalked = 0;
  let lastStatus: number | null = null;
  for (let p = 0; p < maxPages; p++) {
    const qs = cursor
      ? `pagination_type=cursor&cursor=${encodeURIComponent(cursor)}${extraQs ? "&" + extraQs : ""}`
      : `pagination_type=cursor${extraQs ? "&" + extraQs : ""}`;
    const res = await bisonFetch(instance, `/sender-emails?${qs}`);
    lastStatus = res.status;
    if (!res.ok) break;
    const json = await res.json();
    const payload = Array.isArray(json) ? json[0] : json;
    const data: { id: number; status?: string }[] = payload?.data || [];
    for (const s of data) {
      if (typeof s?.id === "number") {
        senders.push({ id: s.id, status: String(s.status ?? "") });
      }
    }
    pagesWalked++;
    const next = payload?.meta?.next_cursor ?? null;
    if (!next || data.length === 0) break;
    cursor = next;
  }
  return { senders, pagesWalked, okStatus: lastStatus };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const instance = resolveInstance(searchParams.get("instance"));
    const pages = Math.max(1, Math.min(10, parseInt(searchParams.get("pages") || "3", 10)));

    // 1. Baseline walk — no filter
    const t0 = Date.now();
    const base = await walkPages(instance, "", pages);
    const baseElapsedMs = Date.now() - t0;
    const baseIds = new Set(base.senders.map((s) => s.id));
    const observedStatusCounts = new Map<string, number>();
    for (const s of base.senders) {
      observedStatusCounts.set(s.status, (observedStatusCounts.get(s.status) ?? 0) + 1);
    }
    const observedStatuses = [...observedStatusCounts.entries()]
      .map(([status, count]) => ({ status, count_in_baseline: count }))
      .sort((a, b) => b.count_in_baseline - a.count_in_baseline);

    // 2. For each observed status, walk N pages with ?status=<X>
    const perStatus: {
      status: string;
      pagesWalked: number;
      httpStatus: number | null;
      returnedCount: number;
      allMatchRequestedStatus: boolean;
      uniqueIds: number;
    }[] = [];
    const filteredIdsByStatus = new Map<string, Set<number>>();
    for (const { status } of observedStatuses) {
      const t = Date.now();
      const filtered = await walkPages(instance, `status=${encodeURIComponent(status)}`, pages);
      void (Date.now() - t);
      const uniqueIds = new Set(filtered.senders.map((s) => s.id));
      filteredIdsByStatus.set(status, uniqueIds);
      const allMatch =
        filtered.senders.length > 0 && filtered.senders.every((s) => s.status === status);
      perStatus.push({
        status,
        pagesWalked: filtered.pagesWalked,
        httpStatus: filtered.okStatus,
        returnedCount: filtered.senders.length,
        allMatchRequestedStatus: allMatch,
        uniqueIds: uniqueIds.size,
      });
    }

    // 3. Disjointness: does the same sender ID appear under two status walks?
    const seenIds = new Map<number, string>(); // id → first status it appeared under
    const overlaps: { id: number; statusA: string; statusB: string }[] = [];
    for (const [status, ids] of filteredIdsByStatus) {
      for (const id of ids) {
        const prior = seenIds.get(id);
        if (prior && prior !== status) {
          if (overlaps.length < 20) overlaps.push({ id, statusA: prior, statusB: status });
        } else if (!prior) {
          seenIds.set(id, status);
        }
      }
    }

    // 4. Coverage: union of filtered IDs vs baseline IDs (within same page budget).
    //    Note: this is a comparison of "first N pages walked" — for the split to be
    //    equivalent to a full walk, the coverage should be ≥ baseline within
    //    matching page budgets, and ideally strictly larger (since each filter
    //    chain gets its own N pages).
    let baselineIdsSeenInFilters = 0;
    for (const id of baseIds) {
      if (seenIds.has(id)) baselineIdsSeenInFilters++;
    }
    const missingFromFilters: number[] = [];
    for (const id of baseIds) {
      if (!seenIds.has(id) && missingFromFilters.length < 20) missingFromFilters.push(id);
    }

    // Verdict — the split strategy is safe only if EVERY filter chain
    // (a) accepts the param, (b) actually filters (all returned match), and
    // (c) has zero overlap with other chains.
    const verdict = {
      status_param_supported:
        perStatus.every((s) => s.httpStatus !== null && s.httpStatus >= 200 && s.httpStatus < 300),
      filters_actually_filtering: perStatus.every((s) => s.allMatchRequestedStatus),
      disjoint: overlaps.length === 0,
      baseline_covered_by_filters:
        baseIds.size > 0 && baselineIdsSeenInFilters === baseIds.size,
    };
    const safeToUse =
      verdict.status_param_supported &&
      verdict.filters_actually_filtering &&
      verdict.disjoint;

    return NextResponse.json({
      instance,
      pages_per_walk: pages,
      baseline: {
        senders_seen: base.senders.length,
        unique_ids: baseIds.size,
        pages_walked: base.pagesWalked,
        elapsed_ms: baseElapsedMs,
      },
      observed_statuses: observedStatuses,
      per_status: perStatus,
      overlaps_sample: overlaps,
      coverage: {
        baseline_ids_seen_in_filters: baselineIdsSeenInFilters,
        baseline_unique: baseIds.size,
        missing_from_filters_sample: missingFromFilters,
      },
      verdict,
      recommendation: safeToUse
        ? "Status-split is viable. Walk each observed status in parallel cursor chains."
        : verdict.status_param_supported && verdict.filters_actually_filtering && !verdict.disjoint
          ? "Status filter works but chains overlap — DON'T use it for splitting (would upsert the same sender twice, harmless but wasteful) OR upsert-dedup and accept the redundancy."
          : "Status split is NOT viable with the raw ?status= param. Try a different partition key (workspace, campaign) or accept sequential cursor.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Diagnostic failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
