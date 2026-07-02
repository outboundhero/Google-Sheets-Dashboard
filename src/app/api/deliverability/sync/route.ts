import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch, resolveInstance } from "@/lib/bison";
import { isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";

// Give the chunk room to walk a lot of cursor pages before the platform kills
// it. Cursor pagination is inherently sequential so raw throughput is lower
// than the old parallel-offset streams, but we walk *all* the data now
// (offset was capped at 1000 pages × 15 = 15k senders per index route).
export const maxDuration = 60;

const BATCH_DELAY_MS = 100;   // small gap between cursor pages to be gentle on Bison
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

// Fetch one cursor page, retrying transient failures (429 / 5xx / network) with
// exponential backoff + jitter. Honors Retry-After when present. Throws on
// terminal failure so the caller can classify the whole chunk correctly.
async function fetchCursorPage(
  instance: BisonInstanceSlug,
  cursor: string | null,
  attempt = 0,
): Promise<{ data: SenderEmail[]; nextCursor: string | null }> {
  const qs = cursor
    ? `pagination_type=cursor&cursor=${encodeURIComponent(cursor)}`
    : `pagination_type=cursor`;
  let status = 0;
  try {
    const res = await bisonFetch(instance, `/sender-emails?${qs}`);
    if (res.ok) {
      const json = await res.json();
      const payload = Array.isArray(json) ? json[0] : json;
      return {
        data: payload?.data || [],
        nextCursor: payload?.meta?.next_cursor ?? null,
      };
    }
    status = res.status;
    if ((status === 429 || status >= 500) && attempt < PAGE_RETRIES) {
      const ra = parseInt(res.headers.get("retry-after") || "", 10);
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(8000, 500 * 2 ** attempt);
      await sleep(wait + Math.floor(Math.random() * 300));
      return fetchCursorPage(instance, cursor, attempt + 1);
    }
  } catch (e) {
    if (attempt < PAGE_RETRIES) {
      await sleep(Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 300));
      return fetchCursorPage(instance, cursor, attempt + 1);
    }
    throw e;
  }
  throw new Error(`Bison ${status} on cursor page`);
}

/**
 * POST /api/deliverability/sync?instance=<slug>
 * Body: { cursor?: string | null, pagesPerChunk?: number }
 *
 * Cursor pagination (Bison's per_page is fixed at 15, and offset is hard-
 * capped at 1000 pages so an instance with >15k senders never got the tail).
 * Walks up to `pagesPerChunk` cursor pages sequentially in a single request,
 * upserts what it collected, and returns the next cursor. The FE loops on
 * the returned cursor until `complete: true`.
 */
export async function POST(request: Request) {
  const t0 = Date.now();
  try {
    const { searchParams } = new URL(request.url);
    const instance = resolveInstance(searchParams.get("instance"));
    const body = await request.json().catch(() => ({}));
    // Accept both {cursor} (new) and {startPage:1} (legacy: 1 means "start over").
    // Anything else in the legacy shape is ignored — old FE code with startPage
    // > 1 wouldn't have made sense with cursor anyway, since cursor tokens are
    // opaque.
    const cursorIn: string | null = typeof body?.cursor === "string" && body.cursor.length > 0 ? body.cursor : null;
    const pagesPerChunk: number = Number.isFinite(body?.pagesPerChunk) ? Math.max(1, Math.min(200, body.pagesPerChunk)) : 40;
    const supabase = getSupabaseAdmin();

    let cursor: string | null = cursorIn;
    const allInboxes: SenderEmail[] = [];
    const failedCursors: string[] = [];
    let pagesWalked = 0;
    let reachedEnd = false;
    let hadFatalError = false;

    for (let p = 0; p < pagesPerChunk; p++) {
      // Guard against creeping past the platform ceiling — leave a few seconds
      // of headroom for the Supabase upserts below.
      if (Date.now() - t0 > 50_000) break;
      let page: { data: SenderEmail[]; nextCursor: string | null };
      try {
        page = await fetchCursorPage(instance, cursor);
      } catch (e) {
        // After PAGE_RETRIES, still failing. Log the cursor and bail — the FE
        // will retry the chunk (this cursor will be redriven on next call).
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[SYNC:${instance}] cursor ${cursor ?? "<start>"} failed: ${msg.slice(0, 200)}`);
        failedCursors.push(cursor ?? "<start>");
        hadFatalError = true;
        break;
      }
      pagesWalked++;
      if (page.data.length > 0) allInboxes.push(...page.data);
      cursor = page.nextCursor;
      if (cursor == null) {
        reachedEnd = true;
        break;
      }
      if (p < pagesPerChunk - 1) await sleep(BATCH_DELAY_MS);
    }
    const fetchMs = Date.now() - t0;

    // Upsert inboxes and their (instance, domain) rows.
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

    // Minimal (instance, domain) upserts to make sure the domain row exists
    // before the inbox row references it. Doesn't clobber inbox_count owned
    // by rebuild_domain_stats.
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
    for (let i = 0; i < minimalDomains.length; i += 500) {
      const batch = minimalDomains.slice(i, i + 500);
      const { error: domErr } = await supabase
        .from("deliverability_domains")
        .upsert(batch, { onConflict: "instance,domain", ignoreDuplicates: true });
      if (domErr) console.error(`[SYNC:${instance}] Domain insert error:`, domErr);
    }

    for (let i = 0; i < inboxRows.length; i += 500) {
      const batch = inboxRows.slice(i, i + 500);
      const { error: inboxErr } = await supabase
        .from("deliverability_inboxes")
        .upsert(batch, { onConflict: "instance,id", ignoreDuplicates: false });
      if (inboxErr) {
        console.error(`[SYNC:${instance}] Inbox upsert error (batch ${i}-${i + batch.length}):`, inboxErr);
        // Fall back to one-by-one so one bad row doesn't stall the whole batch.
        for (const row of batch) {
          const { error: singleErr } = await supabase
            .from("deliverability_inboxes")
            .upsert(row, { onConflict: "instance,id", ignoreDuplicates: false });
          if (singleErr) console.error(`[SYNC:${instance}] Failed inbox ${row.id} (${row.email}):`, singleErr.message);
        }
      }
    }
    const dbMs = Date.now() - tDb;
    const totalMs = Date.now() - t0;

    const complete = reachedEnd && !hadFatalError;
    console.log(
      `[SYNC:${instance}] cursor ${cursorIn ? cursorIn.slice(0, 12) + "…" : "<start>"} → ${cursor ? cursor.slice(0, 12) + "…" : "<end>"}: ${allInboxes.length} inboxes across ${pagesWalked} pages${failedCursors.length ? ` | ${failedCursors.length} cursors failed` : ""} | fetch=${fetchMs}ms db=${dbMs}ms total=${totalMs}ms`,
    );

    return NextResponse.json({
      instance,
      synced: allInboxes.length,
      pagesWalked,
      nextCursor: complete ? null : cursor,
      complete,
      domains: domainSet.size,
      failedCursors,
      // Legacy field kept so any lingering caller reading it doesn't NPE. It
      // has no meaning in cursor mode — the FE progress card should switch
      // to `pagesWalked` for display.
      failedPages: failedCursors,
    });
  } catch (error) {
    console.error(`[SYNC] ERROR after ${Date.now() - t0}ms:`, error);
    const message = error instanceof Error ? error.message : "Sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// PUT — rebuild all domain stats from inboxes via SQL (call after full sync).
// SQL groups by (instance, domain), so this rebuilds for ALL instances at once.
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
