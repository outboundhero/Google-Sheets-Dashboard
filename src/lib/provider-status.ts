// Provider domain lifecycle refresh — orchestrates one pass over a batch of
// tagged Inboxing / MilkBox domains and returns rows ready to upsert into
// `provider_domain_status`.
//
// Design lives in the approved plan file: for MilkBox we do ONE list-scan
// per run and index by lowercase domain name; for Inboxing we look up per
// domain (using a cached provider_domain_id when we have one, falling back
// to a search-by-name).

import * as inboxing from "@/lib/inboxing";
import * as milkbox from "@/lib/milkbox";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

export type ProviderStatusProvider = "inboxing" | "milkbox";
export type ProviderStatusBucket = "active" | "canceled";

export interface RefreshEntry {
  instance: BisonInstanceSlug;
  domain: string;
  provider: ProviderStatusProvider;
  /** Previously-resolved provider id (Inboxing UUID / MilkBox UUID) or null. */
  cached_provider_domain_id: string | null;
}

export interface UpsertRow {
  instance: BisonInstanceSlug;
  domain: string;
  provider: ProviderStatusProvider;
  provider_domain_id: string | null;
  status: ProviderStatusBucket;
  raw_status: string | null;
  failure_reason: string | null;
}

export interface RefreshResult {
  ok: number;
  failed: number;
  results: UpsertRow[];
}

const INBOXING_CONCURRENCY = 8;

// Simple worker-pool runner. Same shape used elsewhere in the codebase
// (handle-sender-reconnect, attach-campaigns).
async function pool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Refresh the provider-lifecycle status for a batch of tagged domains.
 * Never throws — per-entry errors are captured on the row itself
 * (`raw_status: 'error'`, `failure_reason: <message>`) so the caller can
 * upsert the whole batch atomically.
 */
export async function refreshProviderDomainStatus(entries: RefreshEntry[]): Promise<RefreshResult> {
  const milkboxEntries = entries.filter((e) => e.provider === "milkbox");
  const inboxingEntries = entries.filter((e) => e.provider === "inboxing");

  const results: UpsertRow[] = [];
  let ok = 0;
  let failed = 0;

  // ── MilkBox: one list-scan, index by lowercase name, walk entries. ──
  if (milkboxEntries.length > 0) {
    let byName: Map<string, { id: string; status: string | null; active: boolean }> | null = null;
    let listError: string | null = null;
    try {
      const list = await milkbox.listDomainsWithLifecycle();
      byName = new Map(
        list.map((d) => [d.name.toLowerCase(), { id: d.id, status: d.status, active: d.active }]),
      );
    } catch (e) {
      listError = e instanceof Error ? e.message : "MilkBox list failed";
    }

    for (const entry of milkboxEntries) {
      if (listError || byName == null) {
        results.push({
          instance: entry.instance,
          domain: entry.domain,
          provider: "milkbox",
          provider_domain_id: entry.cached_provider_domain_id,
          status: "canceled",
          raw_status: "error",
          failure_reason: (listError || "MilkBox list failed").slice(0, 300),
        });
        failed++;
        continue;
      }
      const hit = byName.get(entry.domain.toLowerCase());
      if (!hit) {
        // Domain not in the account list → deleted at MilkBox.
        results.push({
          instance: entry.instance,
          domain: entry.domain,
          provider: "milkbox",
          provider_domain_id: entry.cached_provider_domain_id,
          status: "canceled",
          raw_status: "not_in_list",
          failure_reason: null,
        });
        ok++;
        continue;
      }
      const rawUpper = (hit.status || "").toUpperCase();
      const isActive = rawUpper === "ACTIVE" && hit.active;
      results.push({
        instance: entry.instance,
        domain: entry.domain,
        provider: "milkbox",
        provider_domain_id: hit.id,
        status: isActive ? "active" : "canceled",
        raw_status: hit.status || (hit.active ? null : "inactive"),
        failure_reason: null,
      });
      ok++;
    }
  }

  // ── Inboxing: per-entry lookup, cached id preferred. ──
  if (inboxingEntries.length > 0) {
    const inbResults = await pool(inboxingEntries, INBOXING_CONCURRENCY, async (entry) => {
      try {
        let id = entry.cached_provider_domain_id;
        if (!id) {
          const found = await inboxing.findDomainByName(entry.domain);
          if (!found) {
            // Not on the account at all — treat as canceled/deleted.
            return {
              instance: entry.instance,
              domain: entry.domain,
              provider: "inboxing" as const,
              provider_domain_id: null,
              status: "canceled" as const,
              raw_status: "not_found",
              failure_reason: null,
            };
          }
          id = found.id;
        }
        try {
          const s = await inboxing.getDomainStatus(id);
          return {
            instance: entry.instance,
            domain: entry.domain,
            provider: "inboxing" as const,
            provider_domain_id: id,
            status: s.status === "active" ? "active" as const : "canceled" as const,
            raw_status: s.rawStatus,
            failure_reason: s.failureReason,
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Inboxing status failed";
          // 404 on the status endpoint → domain has been removed provider-side.
          if (/\b404\b/.test(msg)) {
            return {
              instance: entry.instance,
              domain: entry.domain,
              provider: "inboxing" as const,
              provider_domain_id: id,
              status: "canceled" as const,
              raw_status: "not_found",
              failure_reason: null,
            };
          }
          throw e;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "refresh failed";
        return {
          instance: entry.instance,
          domain: entry.domain,
          provider: "inboxing" as const,
          provider_domain_id: entry.cached_provider_domain_id,
          status: "canceled" as const,
          raw_status: "error",
          failure_reason: msg.slice(0, 300),
        };
      }
    });
    for (const r of inbResults) {
      results.push(r);
      if (r.raw_status === "error") failed++;
      else ok++;
    }
  }

  return { ok, failed, results };
}
