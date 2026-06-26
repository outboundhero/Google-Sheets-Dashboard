import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch, resolveInstance } from "@/lib/bison";
import { isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";

// Give a chunk room to finish (with backoff/retries) before the platform kills
// it — a slow instance + a couple of rate-limit waits used to 504.
export const maxDuration = 60;

const PER_PAGE = 15;
const CONCURRENT = 2;         // gentler: 4 streams × 2 = ~8 concurrent, fewer 429s than ×3
const BATCH_DELAY_MS = 800;
const PAGE_RETRIES = 4;       // transient (429/5xx/network) retries per page

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface SenderEmail {
  id: number;
  name: string;
  email: string;
  daily_limit: number;
  type: string;
  status: string;
  warmup_enabled: boolean;
  tags: { id: number; name: string }[];
  emails_sent_count: number;
  total_replied_count: number;
  total_opened_count: number;
  bounced_count: number;
  warmup_score?: number;
  warmup_daily_limit?: number;
  warmup_emails_sent?: number;
  warmup_replies_received?: number;
  warmup_emails_saved_from_spam?: number;
  warmup_bounces_received_count?: number;
  created_at: string;
  updated_at: string;
}

// Fetch one page, retrying transient failures (rate-limit / 5xx / network) with
// exponential backoff + jitter. This is the core fix for "B2B #2 errors every
// time": the big instances get rate-limited mid-crawl, and without backoff a
// single 429 used to throw and fail the whole chunk → whole instance red.
async function fetchPage(instance: BisonInstanceSlug, page: number, attempt = 0): Promise<{ data: SenderEmail[]; lastPage: number }> {
  let status = 0;
  try {
    const res = await bisonFetch(instance, `/sender-emails?page=${page}&per_page=${PER_PAGE}`);
    if (res.ok) {
      const json = await res.json();
      const payload = Array.isArray(json) ? json[0] : json;
      return { data: payload.data || [], lastPage: payload.meta?.last_page || 1 };
    }
    status = res.status;
    // Honor Retry-After on a 429 when present.
    if ((status === 429 || status >= 500) && attempt < PAGE_RETRIES) {
      const ra = parseInt(res.headers.get("retry-after") || "", 10);
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(8000, 500 * 2 ** attempt);
      await sleep(wait + Math.floor(Math.random() * 300));
      return fetchPage(instance, page, attempt + 1);
    }
  } catch (e) {
    // Network/abort → also transient.
    if (attempt < PAGE_RETRIES) {
      await sleep(Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 300));
      return fetchPage(instance, page, attempt + 1);
    }
    throw e;
  }
  throw new Error(`API error ${status} on page ${page}`);
}

export async function POST(request: Request) {
  const t0 = Date.now();
  try {
    const { searchParams } = new URL(request.url);
    const instance = resolveInstance(searchParams.get("instance"));
    const { startPage = 1, pagesPerChunk = 20 } = await request.json().catch(() => ({}));
    const supabase = getSupabaseAdmin();

    // 1. Fetch first page
    const first = await fetchPage(instance, startPage);
    const { lastPage } = first;
    let allInboxes: SenderEmail[] = [...first.data];

    // 2. Fetch remaining pages concurrently
    const endPage = Math.min(startPage + pagesPerChunk - 1, lastPage);
    const remainingPages: number[] = [];
    for (let p = startPage + 1; p <= endPage; p++) remainingPages.push(p);

    // fetchPage already retries 429/5xx with backoff, so we no longer "stop
    // early" on a rate-limit (that silently skipped the rest of the chunk's
    // pages → those inboxes went stale and could be pruned). If a page still
    // fails after all retries, we record it so the chunk reports incomplete
    // rather than pretending it synced everything.
    const failedPages: number[] = [];
    for (let i = 0; i < remainingPages.length; i += CONCURRENT) {
      const batch = remainingPages.slice(i, i + CONCURRENT);
      const results = await Promise.allSettled(batch.map((p) => fetchPage(instance, p)));
      results.forEach((r, idx) => {
        if (r.status === "fulfilled") {
          allInboxes = allInboxes.concat(r.value.data);
        } else {
          failedPages.push(batch[idx]);
          console.warn(`[SYNC:${instance}] Page ${batch[idx]} failed after retries: ${String(r.reason).slice(0, 120)}`);
        }
      });
      if (i + CONCURRENT < remainingPages.length) {
        await sleep(BATCH_DELAY_MS);
      }
    }
    const fetchMs = Date.now() - t0;

    // 3. Upsert inboxes (tagged with this instance)
    const tDb = Date.now();
    const inboxRows = allInboxes.map((inbox) => ({
      id: inbox.id,
      instance,
      name: inbox.name,
      email: inbox.email,
      domain: inbox.email.split("@")[1]?.toLowerCase() || "",
      status: inbox.status,
      type: inbox.type,
      daily_limit: inbox.daily_limit,
      warmup_enabled: inbox.warmup_enabled,
      tags: inbox.tags,
      emails_sent_count: inbox.emails_sent_count,
      total_replied_count: inbox.total_replied_count,
      total_opened_count: inbox.total_opened_count,
      bounced_count: inbox.bounced_count,
      warmup_score: inbox.warmup_score ?? null,
      warmup_daily_limit: inbox.warmup_daily_limit ?? null,
      warmup_emails_sent: inbox.warmup_emails_sent ?? null,
      warmup_replies_received: inbox.warmup_replies_received ?? null,
      warmup_emails_saved_from_spam: inbox.warmup_emails_saved_from_spam ?? null,
      warmup_bounces_received_count: inbox.warmup_bounces_received_count ?? null,
      created_at: inbox.created_at,
      updated_at: inbox.updated_at,
      synced_at: new Date().toISOString(),
    })).filter((r) => r.domain);

    // Ensure (instance, domain) rows exist first — minimal upsert
    const domainSet = new Map<string, string>();
    for (const inbox of allInboxes) {
      const domain = inbox.email.split("@")[1]?.toLowerCase();
      if (!domain) continue;
      if (!domainSet.has(domain) || inbox.created_at < domainSet.get(domain)!) {
        domainSet.set(domain, inbox.created_at);
      }
    }
    const minimalDomains = Array.from(domainSet.entries()).map(([domain, created_at]) => ({
      instance,
      domain,
      domain_created_at: created_at,
      warmup_status: "open",
      synced_at: new Date().toISOString(),
    }));
    // Insert domains that don't exist yet for this (instance, domain) pair
    for (let i = 0; i < minimalDomains.length; i += 500) {
      const batch = minimalDomains.slice(i, i + 500);
      const { error: domErr } = await supabase
        .from("deliverability_domains")
        .upsert(batch, { onConflict: "instance,domain", ignoreDuplicates: true });
      if (domErr) console.error(`[SYNC:${instance}] Domain insert error:`, domErr);
    }

    // Upsert inboxes in batches of 500
    for (let i = 0; i < inboxRows.length; i += 500) {
      const batch = inboxRows.slice(i, i + 500);
      const { error: inboxErr } = await supabase
        .from("deliverability_inboxes")
        .upsert(batch, { onConflict: "instance,id", ignoreDuplicates: false });
      if (inboxErr) {
        console.error(`[SYNC:${instance}] Inbox upsert error (batch ${i}-${i + batch.length}):`, inboxErr);
        // Try one by one to find the failing row
        for (const row of batch) {
          const { error: singleErr } = await supabase
            .from("deliverability_inboxes")
            .upsert(row, { onConflict: "instance,id", ignoreDuplicates: false });
          if (singleErr) console.error(`[SYNC:${instance}] Failed inbox ${row.id} (${row.email}):`, singleErr.message);
        }
      }
    }
    const dbMs = Date.now() - tDb;

    const nextPage = startPage + pagesPerChunk;
    const complete = nextPage > lastPage;
    const totalMs = Date.now() - t0;

    console.log(`[SYNC:${instance}] Pages ${startPage}-${endPage}: ${allInboxes.length} inboxes${failedPages.length ? ` | ${failedPages.length} pages failed` : ""} | fetch=${fetchMs}ms db=${dbMs}ms total=${totalMs}ms`);

    return NextResponse.json({
      instance,
      synced: allInboxes.length,
      startPage,
      nextPage: complete ? null : nextPage,
      lastPage,
      complete,
      domains: domainSet.size,
      failedPages,              // pages that couldn't be fetched even after retries (usually [])
    });
  } catch (error) {
    console.error(`[SYNC] ERROR after ${Date.now() - t0}ms:`, error);
    const message = error instanceof Error ? error.message : "Sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// PUT — rebuild all domain stats from inboxes via SQL (call after full sync)
// The SQL function now groups by (instance, domain), so this rebuilds for ALL instances at once.
export async function PUT() {
  const t0 = Date.now();
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.rpc("rebuild_domain_stats");
    if (error) {
      console.error(`[SYNC] RPC error:`, error);
      return NextResponse.json({ error: error.message, details: error }, { status: 500 });
    }
    console.log(`[SYNC] Domain rebuild via SQL: ${JSON.stringify(data)} in ${Date.now() - t0}ms`);
    return NextResponse.json(data);
  } catch (error) {
    console.error(`[SYNC] Domain rebuild ERROR:`, error);
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const instancesParam = searchParams.get("instances");
    const instanceParam = searchParams.get("instance");
    const supabase = getSupabaseAdmin();

    // Multi-instance: ?instances=outboundhero,cleaningoutbound
    if (instancesParam) {
      const slugs = instancesParam
        .split(",")
        .map((s) => s.trim())
        .filter(isInstanceSlug);
      if (slugs.length > 0) {
        const { count: inboxCount } = await supabase
          .from("deliverability_inboxes")
          .select("*", { count: "exact", head: true })
          .in("instance", slugs);
        const { count: domainCount } = await supabase
          .from("deliverability_domains")
          .select("*", { count: "exact", head: true })
          .in("instance", slugs);
        return NextResponse.json({ inboxCount, domainCount, instances: slugs });
      }
    }

    if (instanceParam) {
      const instance = resolveInstance(instanceParam);
      const { count: inboxCount } = await supabase
        .from("deliverability_inboxes")
        .select("*", { count: "exact", head: true })
        .eq("instance", instance);
      const { count: domainCount } = await supabase
        .from("deliverability_domains")
        .select("*", { count: "exact", head: true })
        .eq("instance", instance);
      return NextResponse.json({ inboxCount, domainCount, instance });
    }

    // No instance: totals across everything
    const { count: inboxCount } = await supabase
      .from("deliverability_inboxes")
      .select("*", { count: "exact", head: true });
    const { count: domainCount } = await supabase
      .from("deliverability_domains")
      .select("*", { count: "exact", head: true });
    return NextResponse.json({ inboxCount, domainCount });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
