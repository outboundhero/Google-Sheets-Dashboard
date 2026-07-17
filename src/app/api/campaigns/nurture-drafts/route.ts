import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { bisonGetWithRetry, fetchCampaignSenderEmails } from "@/lib/attach-campaigns";
import { ALL_INSTANCE_SLUGS, type BisonInstanceSlug } from "@/lib/bison-instances";

// GET /api/campaigns/nurture-drafts (admin-only)
//
// Surfaces nurture campaigns that are READY TO ACTIVATE across all 4 Bison
// instances: name contains "[Nurture]", status === "draft", >= 100 leads, and
// >= 10 attached sender inboxes. Leads/status/name come free on the campaign
// list; the sender-inbox count does NOT — so we pre-filter to the small
// candidate set first, then fetch sender counts only for those.
//
// Speed:
//  - The campaign LIST is server-side filtered with `search=Nurture`, so each
//    instance returns only nurture campaigns (a handful) instead of hundreds.
//  - The 4 instances are crawled concurrently (Promise.allSettled in crawl()).
//  - List pages use offset per_page=100 fetched concurrently (the searched set
//    is tiny, so this is ~1 page anyway; offset degrades gracefully if a Bison
//    instance ignores `search`).
//  - The per-candidate sender count uses cursor pagination (fetchCampaign-
//    SenderEmails), and results are cached in Redis ~10 min (?fresh=1 bypasses).
export const maxDuration = 120;

const MIN_LEADS = 100;
const MIN_SENDERS = 10;
const SEARCH_QS = `search=${encodeURIComponent("Nurture")}`; // narrows the list server-side
const SENDER_CONCURRENCY = 8; // per-instance candidate sender-count batches
const PAGE_CONCURRENCY = 10;  // concurrent campaign-list pages per instance
const CACHE_KEY = "nurture-drafts:v1";
const CACHE_TTL_S = 600;

interface RawCampaign { id: number; name: string; status: string; total_leads?: number }
export interface NurtureDraft { instance: BisonInstanceSlug; id: number; name: string; leads: number; senders: number }

function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function unwrap(json: unknown): { data?: RawCampaign[]; meta?: { last_page?: number } } {
  // Some Bison endpoints wrap the payload in a single-element array.
  return (Array.isArray(json) ? json[0] : json) ?? {};
}

// Fast offset walk of the `search=Nurture`-filtered list: page 1 → last_page,
// then remaining pages concurrently (usually just page 1 given the search).
async function listCampaigns(instance: BisonInstanceSlug): Promise<RawCampaign[]> {
  const firstRes = await bisonGetWithRetry(instance, `/campaigns?page=1&per_page=100&${SEARCH_QS}`);
  const first = unwrap(await firstRes.json());
  const lastPage = first.meta?.last_page || 1;
  const all: RawCampaign[] = [...(first.data || [])];
  if (lastPage > 1) {
    const pages = Array.from({ length: lastPage - 1 }, (_, i) => i + 2);
    for (let i = 0; i < pages.length; i += PAGE_CONCURRENCY) {
      const batch = pages.slice(i, i + PAGE_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (p) => {
          const r = await bisonGetWithRetry(instance, `/campaigns?page=${p}&per_page=100&${SEARCH_QS}`);
          return unwrap(await r.json()).data || [];
        }),
      );
      for (const r of results) all.push(...r);
    }
  }
  return all;
}

async function nurtureDraftsForInstance(instance: BisonInstanceSlug): Promise<NurtureDraft[]> {
  const campaigns = await listCampaigns(instance);
  const candidates = campaigns.filter((c) =>
    (c.name || "").toLowerCase().includes("[nurture]") &&
    (c.status || "").trim().toLowerCase() === "draft" &&
    (c.total_leads || 0) >= MIN_LEADS,
  );

  const out: NurtureDraft[] = [];
  for (let i = 0; i < candidates.length; i += SENDER_CONCURRENCY) {
    const batch = candidates.slice(i, i + SENDER_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (c) => {
        try {
          const ids = await fetchCampaignSenderEmails(instance, c.id);
          return { instance, id: c.id, name: c.name, leads: c.total_leads || 0, senders: ids.length } as NurtureDraft;
        } catch {
          return null; // sender count failed for this one — skip (refresh retries)
        }
      }),
    );
    for (const r of results) if (r && r.senders >= MIN_SENDERS) out.push(r);
  }
  return out;
}

async function crawl(): Promise<{ campaigns: NurtureDraft[]; errors: { instance: string; error: string }[] }> {
  const results = await Promise.allSettled(ALL_INSTANCE_SLUGS.map((i) => nurtureDraftsForInstance(i)));
  const campaigns: NurtureDraft[] = [];
  const errors: { instance: string; error: string }[] = [];
  results.forEach((r, idx) => {
    const instance = ALL_INSTANCE_SLUGS[idx];
    if (r.status === "fulfilled") campaigns.push(...r.value);
    else errors.push({ instance, error: r.reason instanceof Error ? r.reason.message : "failed" });
  });
  campaigns.sort((a, b) => a.instance.localeCompare(b.instance) || a.name.localeCompare(b.name));
  return { campaigns, errors };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const fresh = searchParams.get("fresh") === "1";
  const redis = getRedis();

  if (!fresh && redis) {
    const cached = await redis.get<{ campaigns: NurtureDraft[]; errors: { instance: string; error: string }[] }>(CACHE_KEY);
    if (cached) return NextResponse.json({ ...cached, cached: true });
  }

  const payload = await crawl();
  // Cache only a clean full crawl (don't cache a partial with instance errors).
  if (redis && payload.errors.length === 0) {
    await redis.set(CACHE_KEY, payload, { ex: CACHE_TTL_S });
  }
  return NextResponse.json({ ...payload, cached: false });
}
