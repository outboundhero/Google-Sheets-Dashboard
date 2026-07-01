// Shared helpers for the "Attach Inboxes to Campaigns" flow.
//
// Two routes use these: the main per-campaign POST
// (`/api/deliverability/attach-campaigns`) and the prepare batch POST
// (`/api/deliverability/attach-campaigns/prepare`) that lets the FE prefetch
// tag → sender-email IDs once per unique (instance, tag_id) instead of
// redoing the same work per campaign.
//
// All Bison pagination here is cursor-based: per_page on EmailBison endpoints
// is fixed at 15 (docs.emailbison.com/get-started/pagination), so a 419-campaign
// batch on offset-mode would be ~30 pages/tag × N tags × 419 fetches. Cursor
// pagination is faster server-side + isn't capped at 1000 pages.

import { bisonFetch } from "@/lib/bison";
import { getSupabaseAdmin } from "@/lib/supabase";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Bison occasionally throws 429/502/503/504 under batch load. The original code
// path did `if (!res.ok) break;` which silently truncated pagination — that's
// what caused most campaigns to show "No matches" in the 419-campaign case.
// Retries the same page up to `attempts` times with jittered backoff, then
// throws so the caller sees a real error (not a partial result).
export async function bisonGetWithRetry(
  instance: BisonInstanceSlug,
  path: string,
  attempts = 4,
): Promise<Response> {
  let lastErr = "";
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await bisonFetch(instance, path);
      if (res.ok) return res;
      if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
        lastErr = `HTTP ${res.status}`;
        await delay(500 * (i + 1) + Math.floor(Math.random() * 400));
        continue;
      }
      const body = await res.text().catch(() => "");
      throw new Error(`Bison ${res.status} on ${path}: ${body.slice(0, 200)}`);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : "request failed";
      if (i < attempts - 1) {
        await delay(500 * (i + 1) + Math.floor(Math.random() * 400));
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Bison ${path} failed after ${attempts} attempts: ${lastErr}`);
}

// Walks all sender emails matching a tag using cursor pagination.
export async function fetchSenderEmailIdsByTag(
  instance: BisonInstanceSlug,
  tagId: number,
): Promise<number[]> {
  const allIds: number[] = [];
  let cursor: string | null = null;
  let guard = 0;
  while (true) {
    if (guard++ > 5000) throw new Error(`sender-emails cursor runaway (tag ${tagId}, ${instance})`);
    const qs = cursor
      ? `tag_ids[]=${tagId}&pagination_type=cursor&cursor=${encodeURIComponent(cursor)}`
      : `tag_ids[]=${tagId}&pagination_type=cursor`;
    const res = await bisonGetWithRetry(instance, `/sender-emails?${qs}`);
    const json = await res.json();
    // Bison sometimes wraps the response in a single-element array on this endpoint.
    const payload = Array.isArray(json) ? json[0] : json;
    const data = payload?.data || [];
    for (const e of data) allIds.push(e.id);
    const nextCursor = payload?.meta?.next_cursor ?? null;
    if (!nextCursor || data.length === 0) break;
    cursor = nextCursor;
  }
  return allIds;
}

// Walks all already-attached sender emails for a campaign using cursor pagination.
export async function fetchCampaignSenderEmails(
  instance: BisonInstanceSlug,
  campaignId: number,
): Promise<number[]> {
  const allIds: number[] = [];
  let cursor: string | null = null;
  let guard = 0;
  while (true) {
    if (guard++ > 5000) throw new Error(`campaign senders cursor runaway (campaign ${campaignId}, ${instance})`);
    const qs = cursor
      ? `pagination_type=cursor&cursor=${encodeURIComponent(cursor)}`
      : `pagination_type=cursor`;
    const res = await bisonGetWithRetry(instance, `/campaigns/${campaignId}/sender-emails?${qs}`);
    const json = await res.json();
    const data = json?.data || [];
    for (const e of data) allIds.push(e.id);
    const nextCursor = json?.meta?.next_cursor ?? null;
    if (!nextCursor || data.length === 0) break;
    cursor = nextCursor;
  }
  return allIds;
}

// Loads the set of domains on `instance` that are ≥21 days old (warmed up).
// Extracted so /prepare can compute this ONCE across many tags instead of
// per-tag / per-campaign.
export async function getWarmedUpDomainSet(instance: BisonInstanceSlug): Promise<Set<string>> {
  const supabase = getSupabaseAdmin();
  const warmupCutoff = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString();
  const domains = new Set<string>();
  let offset = 0;
  while (true) {
    const { data } = await supabase
      .from("deliverability_domains")
      .select("domain")
      .eq("instance", instance)
      .lte("domain_created_at", warmupCutoff)
      .range(offset, offset + 999);
    if (!data || data.length === 0) break;
    for (const d of data) domains.add(d.domain);
    if (data.length < 1000) break;
    offset += 1000;
  }
  return domains;
}

// Filters a list of Bison sender-email IDs down to those whose Supabase-side
// domain is warmed up (≥21 days old) on this instance. Pass a prebuilt
// warmedUpDomains set if you already have one to avoid the per-call load.
export async function warmupFilterIds(
  instance: BisonInstanceSlug,
  ids: number[],
  warmedUpDomains?: Set<string>,
): Promise<number[]> {
  if (ids.length === 0) return [];
  const domains = warmedUpDomains ?? (await getWarmedUpDomainSet(instance));
  const supabase = getSupabaseAdmin();
  const warmedUpIds = new Set<number>();
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const { data } = await supabase
      .from("deliverability_inboxes")
      .select("id, domain")
      .eq("instance", instance)
      .in("id", batch);
    if (data) {
      for (const inbox of data) {
        if (domains.has(inbox.domain)) warmedUpIds.add(inbox.id);
      }
    }
  }
  return ids.filter((id) => warmedUpIds.has(id));
}

// Simple worker-pool over an array of items — used server-side to fan tag
// fetches across a bounded set of parallel Bison connections.
export async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
