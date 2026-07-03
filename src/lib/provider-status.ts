// Provider domain lifecycle refresh — orchestrates one pass over a batch of
// tagged Inboxing / MilkBox domains and returns rows ready to upsert into
// `provider_domain_status`.
//
// Design: for BOTH providers, one paginated list scan per run indexes by
// lowercase domain name. Zero per-domain HTTP calls. This scales cleanly to
// thousands of tagged domains without hitting provider rate limits (the
// original per-domain search approach got 98% of Inboxing calls 429'd on
// the first cron run).

import * as inboxing from "@/lib/inboxing";
import * as milkbox from "@/lib/milkbox";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

export type ProviderStatusProvider = "inboxing" | "milkbox";
export type ProviderStatusBucket = "active" | "canceled";

export interface RefreshEntry {
  instance: BisonInstanceSlug;
  domain: string;
  provider: ProviderStatusProvider;
  /** Previously-resolved provider id (Inboxing UUID / MilkBox UUID) or null.
   *  Not required — the list scans return ids fresh — but preserved on the
   *  upsert row so we keep the cached value if the domain isn't in the current
   *  list. */
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

  // ── MilkBox: one list scan, index by lowercase name, walk entries. ──
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

  // ── Inboxing: same shape as MilkBox — one list scan, in-memory join. ──
  if (inboxingEntries.length > 0) {
    let byName: Map<string, { id: string; status: string }> | null = null;
    let listError: string | null = null;
    try {
      const list = await inboxing.listDomainsWithLifecycle();
      byName = new Map(
        list.map((d) => [d.name.toLowerCase(), { id: d.id, status: d.status }]),
      );
    } catch (e) {
      listError = e instanceof Error ? e.message : "Inboxing list failed";
    }

    for (const entry of inboxingEntries) {
      if (listError || byName == null) {
        results.push({
          instance: entry.instance,
          domain: entry.domain,
          provider: "inboxing",
          provider_domain_id: entry.cached_provider_domain_id,
          status: "canceled",
          raw_status: "error",
          failure_reason: (listError || "Inboxing list failed").slice(0, 300),
        });
        failed++;
        continue;
      }
      const hit = byName.get(entry.domain.toLowerCase());
      if (!hit) {
        // Domain not on the Inboxing account list → deleted/removed there.
        results.push({
          instance: entry.instance,
          domain: entry.domain,
          provider: "inboxing",
          provider_domain_id: entry.cached_provider_domain_id,
          status: "canceled",
          raw_status: "not_in_list",
          failure_reason: null,
        });
        ok++;
        continue;
      }
      const rawLower = (hit.status || "").toLowerCase();
      const isActive = rawLower === "active";
      results.push({
        instance: entry.instance,
        domain: entry.domain,
        provider: "inboxing",
        provider_domain_id: hit.id,
        status: isActive ? "active" : "canceled",
        raw_status: hit.status || null,
        failure_reason: null,
      });
      ok++;
    }
  }

  return { ok, failed, results };
}
