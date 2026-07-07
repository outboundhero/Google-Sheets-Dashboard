// Provider domain lifecycle refresh — orchestrates one pass over a batch of
// tagged Inboxing / MilkBox / ScaledMail domains and returns rows ready to
// upsert into `provider_domain_status`.
//
// Design: for ALL providers, one account-wide list scan per run indexes by
// lowercase domain name. Zero per-domain HTTP calls. This scales cleanly to
// thousands of tagged domains without hitting provider rate limits (the
// original per-domain search approach got 98% of Inboxing calls 429'd on
// the first cron run).

import * as inboxing from "@/lib/inboxing";
import * as milkbox from "@/lib/milkbox";
import * as scaledmail from "@/lib/scaledmail";
import { getSupabaseAdmin } from "@/lib/supabase";
import { isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";

export type ProviderStatusProvider = "inboxing" | "milkbox" | "scaledmail";
export const PROVIDER_STATUS_PROVIDERS: ProviderStatusProvider[] = ["inboxing", "milkbox", "scaledmail"];

export function providerFromTags(tags: string[] | null): ProviderStatusProvider | null {
  if (!Array.isArray(tags)) return null;
  // Match ANY tag that STARTS WITH the provider name (case-insensitive).
  // Real tags in prod include variants like "Milkbox - Microsoft",
  // "ScaledMail - Microsoft" and "ScaledMail-Microsoft"; anchoring on the
  // prefix catches all of them without over-matching (an "Inboxing +
  // Nurture" tag still matches Inboxing, and "Hyperscale" does NOT match
  // ScaledMail).
  const lower = tags.map((t) => (t || "").trim().toLowerCase()).filter(Boolean);
  if (lower.some((t) => t.startsWith("inboxing"))) return "inboxing";
  if (lower.some((t) => t.startsWith("milkbox"))) return "milkbox";
  if (lower.some((t) => t.startsWith("scaledmail"))) return "scaledmail";
  return null;
}
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
  const scaledmailEntries = entries.filter((e) => e.provider === "scaledmail");

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

  // ── ScaledMail: same shape — one account-wide list scan, in-memory join.
  //    Status semantics: the /domains list is the account's current domains;
  //    a missing status field on a listed domain means it's simply live, so
  //    presence-with-no-status counts as active. ──
  if (scaledmailEntries.length > 0) {
    let byName: Map<string, { id: string; status: string | null }> | null = null;
    let listError: string | null = null;
    try {
      const list = await scaledmail.listDomainsWithLifecycle();
      byName = new Map(list.map((d) => [d.name, { id: d.id, status: d.status }]));
    } catch (e) {
      listError = e instanceof Error ? e.message : "ScaledMail list failed";
    }

    for (const entry of scaledmailEntries) {
      if (listError || byName == null) {
        results.push({
          instance: entry.instance,
          domain: entry.domain,
          provider: "scaledmail",
          provider_domain_id: entry.cached_provider_domain_id,
          status: "canceled",
          raw_status: "error",
          failure_reason: (listError || "ScaledMail list failed").slice(0, 300),
        });
        failed++;
        continue;
      }
      const hit = byName.get(entry.domain.toLowerCase());
      if (!hit) {
        // Domain not on the ScaledMail account list → canceled/removed there.
        results.push({
          instance: entry.instance,
          domain: entry.domain,
          provider: "scaledmail",
          provider_domain_id: entry.cached_provider_domain_id,
          status: "canceled",
          raw_status: "not_in_list",
          failure_reason: null,
        });
        ok++;
        continue;
      }
      const rawLower = (hit.status || "").toLowerCase();
      const isActive = hit.status === null || ["active", "completed", "success", "live"].includes(rawLower);
      results.push({
        instance: entry.instance,
        domain: entry.domain,
        provider: "scaledmail",
        provider_domain_id: hit.id || entry.cached_provider_domain_id,
        status: isActive ? "active" : "canceled",
        raw_status: hit.status,
        failure_reason: null,
      });
      ok++;
    }
  }

  return { ok, failed, results };
}

// ─────────────────────────────────────────────────────────────────────────
// Full check orchestration — shared by the daily cron (all providers) and
// the manual per-provider trigger on the deliverability page.
// ─────────────────────────────────────────────────────────────────────────

// Cap per invocation so we don't blow the Vercel timeout on the very first
// pass when nothing is cached yet.
const MAX_ENTRIES_PER_RUN = 5000;

interface DomainRow {
  instance: string;
  domain: string;
  tags: string[] | null;
}

interface CachedStatusRow {
  instance: string;
  domain: string;
  provider: string | null;
  provider_domain_id: string | null;
  checked_at: string | null;
}

export interface ProviderCheckSummary {
  scanned: number;
  processed: number;
  canceled: number;
  failed: number;
  pruned: number;
  durationMs: number;
}

/**
 * One full status pass: load tagged domains (optionally only one provider's),
 * refresh oldest-checked-first, upsert into `provider_domain_status`, prune
 * rows whose tag is gone. When `filter` is set, pruning is scoped to that
 * provider's rows so a single-provider run never deletes the others' data.
 */
export async function runProviderDomainStatusCheck(
  filter?: ProviderStatusProvider,
): Promise<ProviderCheckSummary> {
  const t0 = Date.now();
  const supabase = getSupabaseAdmin();

  // 1. Load every tagged domain. deliverability_domains has ~few thousand
  //    rows total so fetching all in one shot is fine.
  const tagged: Array<{ instance: BisonInstanceSlug; domain: string; provider: ProviderStatusProvider }> = [];
  {
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from("deliverability_domains")
        .select("instance, domain, tags")
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(`deliverability_domains read: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const raw of data as DomainRow[]) {
        if (!isInstanceSlug(raw.instance)) continue;
        const provider = providerFromTags(raw.tags);
        if (!provider) continue;
        if (filter && provider !== filter) continue;
        tagged.push({ instance: raw.instance, domain: raw.domain, provider });
      }
      if (data.length < PAGE) break;
      offset += PAGE;
    }
  }

  // 2. Merge in whatever provider_domain_status already knows so we can
  //    reuse cached provider ids and pick the oldest-checked rows first.
  const cachedByKey = new Map<string, CachedStatusRow>();
  {
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from("provider_domain_status")
        .select("instance, domain, provider, provider_domain_id, checked_at")
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(`provider_domain_status read: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const r of data as CachedStatusRow[]) {
        cachedByKey.set(`${r.instance}:${r.domain}`, r);
      }
      if (data.length < PAGE) break;
      offset += PAGE;
    }
  }

  // 3. RefreshEntry list, oldest-checked-first so if we ever hit
  //    MAX_ENTRIES_PER_RUN we make progress on the least-fresh rows.
  const entries: RefreshEntry[] = tagged.map((t) => {
    const cached = cachedByKey.get(`${t.instance}:${t.domain}`);
    return {
      instance: t.instance,
      domain: t.domain,
      provider: t.provider,
      cached_provider_domain_id: cached?.provider_domain_id ?? null,
    };
  });
  entries.sort((a, b) => {
    // Null checked_at (never checked) sorts before any real timestamp.
    const av = cachedByKey.get(`${a.instance}:${a.domain}`)?.checked_at ?? "";
    const bv = cachedByKey.get(`${b.instance}:${b.domain}`)?.checked_at ?? "";
    return av.localeCompare(bv);
  });
  const batch = entries.slice(0, MAX_ENTRIES_PER_RUN);

  // 4. Refresh + upsert.
  const { failed, results } = await refreshProviderDomainStatus(batch);
  if (results.length > 0) {
    const nowIso = new Date().toISOString();
    const rows = results.map((r: UpsertRow) => ({
      instance: r.instance,
      domain: r.domain,
      provider: r.provider,
      provider_domain_id: r.provider_domain_id,
      status: r.status,
      raw_status: r.raw_status,
      failure_reason: r.failure_reason,
      checked_at: nowIso,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const slice = rows.slice(i, i + 500);
      const { error: upErr } = await supabase
        .from("provider_domain_status")
        .upsert(slice, { onConflict: "instance,domain" });
      if (upErr) {
        console.error(`[provider-status] upsert failed at chunk ${i}: ${upErr.message}`);
      }
    }
  }

  // 5. Prune rows that no longer carry a provider tag (client detagged,
  //    domain retagged as "Burnt", …). Scoped to `filter` when set.
  const currentKeys = new Set(tagged.map((t) => `${t.instance}:${t.domain}`));
  let pruned = 0;
  for (const [key, row] of cachedByKey) {
    if (filter && row.provider !== filter) continue;
    if (currentKeys.has(key)) continue;
    const { error: delErr } = await supabase
      .from("provider_domain_status")
      .delete()
      .eq("instance", row.instance)
      .eq("domain", row.domain);
    if (!delErr) pruned++;
  }

  const durationMs = Date.now() - t0;
  const canceledCount = results.filter((r) => r.status === "canceled").length;
  console.log(
    `[provider-status${filter ? `/${filter}` : ""}] scanned=${tagged.length} processed=${batch.length} canceled=${canceledCount} failed=${failed} pruned=${pruned} duration=${durationMs}ms`,
  );

  return {
    scanned: tagged.length,
    processed: batch.length,
    canceled: canceledCount,
    failed,
    pruned,
    durationMs,
  };
}
