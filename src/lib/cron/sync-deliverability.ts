import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

// Bison's per_page is fixed at 15 (docs.emailbison.com/get-started/pagination),
// AND its traditional offset pagination is hard-capped at 1000 pages per index
// route. That's 15,000 senders max — an instance with 30k+ inboxes silently
// truncated at 15k with offset. Cursor pagination is the only way to walk the
// full set. So this cron now stores an opaque cursor token in Redis instead of
// a page number and follows meta.next_cursor until it returns null.
const CONCURRENT_UPSERT_BATCH = 500;
const BATCH_DELAY_MS = 150;
const STATS_REBUILD_GRACE_MS = 8000;
const MAX_RUN_MS = 60_000;

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

function getRedis() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function cursorKey(instance: BisonInstanceSlug): string {
  // v2 suffix because the pre-cursor key stored a numeric page. If we reused
  // the same key an old integer would be read back as a truthy string and
  // sent to Bison as an "opaque" cursor — Bison would reject it.
  return `cron:deliverability:cursorv2:${instance}`;
}

// Returns the next opaque Bison cursor to fetch, or null to start a fresh pass
// from the beginning of the sender list.
async function getCursor(instance: BisonInstanceSlug): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  const val = await redis.get<string>(cursorKey(instance));
  return typeof val === "string" && val.length > 0 ? val : null;
}

async function setCursor(instance: BisonInstanceSlug, cursor: string | null): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  if (cursor == null) {
    await redis.del(cursorKey(instance));
  } else {
    await redis.set(cursorKey(instance), cursor);
  }
}

// --- Pruning-pass tracking ----------------------------------------------------
// A "pass" = one full walk (null cursor → last page → null cursor), which may
// span several cron runs. Every synced row is stamped with synced_at; rows not
// re-stamped during a clean, complete pass are stale (deleted in Bison) and
// get pruned. `clean` flips false if any page/upsert error occurs.
interface PassState {
  startedAt: string;
  clean: boolean;
}

function passKey(instance: BisonInstanceSlug): string {
  return `cron:deliverability:pass:${instance}`;
}

async function getPass(instance: BisonInstanceSlug): Promise<PassState | null> {
  const redis = getRedis();
  if (!redis) return null;
  const val = await redis.get<PassState>(passKey(instance));
  return val && typeof val.startedAt === "string" ? val : null;
}

async function setPass(instance: BisonInstanceSlug, state: PassState): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.set(passKey(instance), state);
}

async function clearPass(instance: BisonInstanceSlug): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(passKey(instance));
}

// One page of /sender-emails via cursor pagination. `cursor === null` means
// "start from the beginning" — Bison ignores the missing cursor param and
// returns the first page. Returns `nextCursor: null` when the walk has ended.
async function fetchCursorPage(
  instance: BisonInstanceSlug,
  cursor: string | null,
): Promise<{ data: SenderEmail[]; nextCursor: string | null; status: number }> {
  const qs = cursor
    ? `pagination_type=cursor&cursor=${encodeURIComponent(cursor)}`
    : `pagination_type=cursor`;
  const res = await bisonFetch(instance, `/sender-emails?${qs}`);
  if (!res.ok) {
    // Preserve status in a throwable so the caller can distinguish 429 (pause
    // the run) from other errors (mark pass unclean).
    const err = new Error(`Bison ${res.status}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  // Some Bison endpoints wrap the payload in a single-element array; guard.
  const payload = Array.isArray(json) ? json[0] : json;
  return {
    data: payload?.data || [],
    nextCursor: payload?.meta?.next_cursor ?? null,
    status: res.status,
  };
}

export async function runDeliverabilitySync(instance: BisonInstanceSlug): Promise<NextResponse> {
  const t0 = Date.now();
  const deadline = t0 + MAX_RUN_MS - STATS_REBUILD_GRACE_MS;
  const supabase = getSupabaseAdmin();

  try {
    const startCursor = await getCursor(instance);
    const isNewPass = startCursor == null;
    if (isNewPass) {
      await setPass(instance, { startedAt: new Date().toISOString(), clean: true });
    }

    const collected: SenderEmail[] = [];
    let cursor: string | null = startCursor;
    let hadError = false;
    let stoppedForRateLimit = false;
    let reachedEnd = false;
    let pagesWalked = 0;

    // Cursor is inherently sequential — each next_cursor is only known after
    // the current response arrives. Walk pages one at a time until we hit the
    // per-run deadline or the walk ends (next_cursor === null).
    for (;;) {
      if (Date.now() >= deadline) break;
      let page;
      try {
        page = await fetchCursorPage(instance, cursor);
      } catch (e) {
        const err = e as Error & { status?: number };
        if (err.status === 429) {
          stoppedForRateLimit = true;
          console.warn(`[cron/deliverability:${instance}] Bison 429 at page ${pagesWalked + 1} — resuming next run`);
        } else {
          hadError = true;
          console.error(`[cron/deliverability:${instance}] cursor fetch failed:`, err.message);
        }
        break;
      }
      pagesWalked++;
      if (page.data.length > 0) collected.push(...page.data);
      cursor = page.nextCursor;
      if (cursor == null) {
        // Bison signaled end-of-walk. We've seen every sender for this pass.
        reachedEnd = true;
        break;
      }
      // Small pacing gap. Cursor mode is one request per iteration (no
      // concurrent batches) so we can be much gentler than offset mode.
      if (Date.now() < deadline) await sleep(BATCH_DELAY_MS);
    }

    const completedFullPass = reachedEnd && !stoppedForRateLimit && !hadError;

    // Upsert (instance, domain) — insert-only, don't clobber inbox_count owned by rebuild_domain_stats
    const domainEarliest = new Map<string, string>();
    for (const inbox of collected) {
      const domain = inbox.email?.split("@")[1]?.toLowerCase();
      if (!domain) continue;
      const existing = domainEarliest.get(domain);
      if (!existing || inbox.created_at < existing) domainEarliest.set(domain, inbox.created_at);
    }
    const domainRows = Array.from(domainEarliest.entries()).map(([domain, created_at]) => ({
      instance,
      domain,
      domain_created_at: created_at,
      warmup_status: "open",
      synced_at: new Date().toISOString(),
    }));
    for (let i = 0; i < domainRows.length; i += CONCURRENT_UPSERT_BATCH) {
      const { error } = await supabase
        .from("deliverability_domains")
        .upsert(domainRows.slice(i, i + CONCURRENT_UPSERT_BATCH), { onConflict: "instance,domain", ignoreDuplicates: true });
      if (error) console.error(`[cron/deliverability:${instance}] domain upsert failed:`, error.message);
    }

    // Warmup-days memory across instance moves (Spencer): freeze each domain's
    // FIRST-ever-seen created date in domain_first_created (keyed by domain
    // only, no instance). ignoreDuplicates → the first write wins forever, so
    // moving a domain to another instance (new Bison created_at) no longer
    // resets its warmup-day count — readers prefer this origin date.
    const firstSeenRows = Array.from(domainEarliest.entries()).map(([domain, created_at]) => ({
      domain,
      first_created_at: created_at,
      first_instance: instance,
    }));
    for (let i = 0; i < firstSeenRows.length; i += CONCURRENT_UPSERT_BATCH) {
      const { error } = await supabase
        .from("domain_first_created")
        .upsert(firstSeenRows.slice(i, i + CONCURRENT_UPSERT_BATCH), { onConflict: "domain", ignoreDuplicates: true });
      if (error) console.error(`[cron/deliverability:${instance}] first-created upsert failed:`, error.message);
    }

    // Upsert inboxes
    const inboxRows = collected
      .filter((i) => i.email?.includes("@"))
      .map((i) => ({
        id: i.id,
        instance,
        name: i.name,
        email: i.email,
        domain: i.email.split("@")[1].toLowerCase(),
        status: i.status,
        type: i.type,
        daily_limit: i.daily_limit,
        warmup_enabled: i.warmup_enabled,
        tags: i.tags,
        emails_sent_count: i.emails_sent_count,
        total_replied_count: i.total_replied_count,
        total_opened_count: i.total_opened_count,
        bounced_count: i.bounced_count,
        warmup_score: i.warmup_score ?? null,
        warmup_daily_limit: i.warmup_daily_limit ?? null,
        warmup_emails_sent: i.warmup_emails_sent ?? null,
        warmup_replies_received: i.warmup_replies_received ?? null,
        warmup_emails_saved_from_spam: i.warmup_emails_saved_from_spam ?? null,
        warmup_bounces_received_count: i.warmup_bounces_received_count ?? null,
        created_at: i.created_at,
        updated_at: i.updated_at,
        synced_at: new Date().toISOString(),
      }));
    for (let i = 0; i < inboxRows.length; i += CONCURRENT_UPSERT_BATCH) {
      const { error } = await supabase
        .from("deliverability_inboxes")
        .upsert(inboxRows.slice(i, i + CONCURRENT_UPSERT_BATCH), { onConflict: "instance,id", ignoreDuplicates: false });
      if (error) {
        hadError = true;
        console.error(`[cron/deliverability:${instance}] inbox upsert failed:`, error.message);
      }
    }

    // Advance cursor; prune stale rows + rebuild stats after a full pass.
    let statsRebuilt = false;
    let pruned = 0;
    if (completedFullPass) {
      // Clear cursor → next cron run starts a fresh pass from the top.
      await setCursor(instance, null);

      // Prune inboxes that no longer exist in Bison: rows for this instance not
      // re-stamped during this pass (synced_at older than the pass start).
      // Only runs after a clean, error-free pass, and bails if it would delete
      // an implausibly large share — a guard against a bad/partial Bison crawl.
      const pass = await getPass(instance);
      if (pass?.startedAt && pass.clean && !hadError) {
        const { count: totalCount } = await supabase
          .from("deliverability_inboxes")
          .select("id", { count: "exact", head: true })
          .eq("instance", instance);
        const { count: staleCount } = await supabase
          .from("deliverability_inboxes")
          .select("id", { count: "exact", head: true })
          .eq("instance", instance)
          .lt("synced_at", pass.startedAt);
        const total = totalCount ?? 0;
        const stale = staleCount ?? 0;
        if (stale > 0 && total > 0 && stale / total <= 0.4) {
          const { error: delErr, count: delCount } = await supabase
            .from("deliverability_inboxes")
            .delete({ count: "exact" })
            .eq("instance", instance)
            .lt("synced_at", pass.startedAt);
          if (delErr) console.error(`[cron/deliverability:${instance}] prune failed:`, delErr.message);
          else pruned = delCount ?? 0;
        } else if (stale > 0) {
          console.warn(
            `[cron/deliverability:${instance}] prune skipped — ${stale}/${total} stale exceeds 40% safety cap`,
          );
        }
      } else if (pass) {
        console.warn(`[cron/deliverability:${instance}] prune skipped — pass had fetch/upsert errors`);
      }
      await clearPass(instance);

      // rebuild_domain_stats recomputes inbox_count and drops orphan domains —
      // run it AFTER the prune so counts reflect the cleaned-up inbox set.
      const { error: rpcErr } = await supabase.rpc("rebuild_domain_stats");
      if (rpcErr) console.error(`[cron/deliverability:${instance}] rebuild_domain_stats failed:`, rpcErr.message);
      else statsRebuilt = true;
    } else {
      // Save where we left off so next cron run resumes from this cursor.
      // If we bailed for a rate limit, `cursor` still holds the cursor of the
      // page we were about to fetch; on any other error, save it too so we
      // don't lose ground.
      await setCursor(instance, cursor);
      if (hadError) {
        const pass = await getPass(instance);
        if (pass && pass.clean) await setPass(instance, { ...pass, clean: false });
      }
    }

    const durationMs = Date.now() - t0;
    console.log(
      `[cron/deliverability:${instance}] pages=${pagesWalked} inboxes=${inboxRows.length} domains=${domainRows.length} fullPass=${completedFullPass} pruned=${pruned} statsRebuilt=${statsRebuilt} rateLimited=${stoppedForRateLimit} duration=${durationMs}ms`,
    );
    return NextResponse.json({
      instance,
      pagesWalked,
      inboxes: inboxRows.length,
      domains: domainRows.length,
      completedFullPass,
      rateLimited: stoppedForRateLimit,
      hadError,
      pruned,
      statsRebuilt,
      // The cursor to resume from on the next run (null = start a fresh pass).
      nextCursor: completedFullPass ? null : cursor,
      durationMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cron deliverability sync failed";
    console.error(`[cron/deliverability:${instance}]`, message);
    return NextResponse.json({ error: message, instance }, { status: 500 });
  }
}
