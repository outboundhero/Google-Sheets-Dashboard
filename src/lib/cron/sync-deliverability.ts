import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

const PER_PAGE = 15;
const CONCURRENT = 3;
const BATCH_DELAY_MS = 800;
const STATS_REBUILD_GRACE_MS = 8000;

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
  const { Redis } = require("@upstash/redis") as typeof import("@upstash/redis");
  return new Redis({ url, token });
}

function cursorKey(instance: BisonInstanceSlug): string {
  return `cron:deliverability:cursor:${instance}`;
}

async function getCursor(instance: BisonInstanceSlug): Promise<number> {
  const redis = getRedis();
  if (!redis) return 1;
  const val = await redis.get<number>(cursorKey(instance));
  return typeof val === "number" && val > 0 ? val : 1;
}

async function setCursor(instance: BisonInstanceSlug, page: number): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.set(cursorKey(instance), page);
}

// --- Pruning-pass tracking ----------------------------------------------------
// A "pass" = one full crawl of an instance's inboxes (cursor 1 -> lastPage),
// which may span several cron runs. Every synced row is stamped with synced_at;
// rows not re-stamped during a clean, complete pass are stale (deleted in
// Bison) and get pruned. `clean` flips false if any page/upsert error occurs.
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

async function fetchPage(
  instance: BisonInstanceSlug,
  page: number,
): Promise<{ data: SenderEmail[]; lastPage: number }> {
  const res = await bisonFetch(instance, `/sender-emails?page=${page}&per_page=${PER_PAGE}`);
  if (!res.ok) throw new Error(`Bison ${res.status} on page ${page}`);
  const json = await res.json();
  const payload = Array.isArray(json) ? json[0] : json;
  return { data: payload.data || [], lastPage: payload.meta?.last_page || 1 };
}

export async function runDeliverabilitySync(instance: BisonInstanceSlug): Promise<NextResponse> {
  const t0 = Date.now();
  const deadline = t0 + 60_000 - STATS_REBUILD_GRACE_MS;
  const supabase = getSupabaseAdmin();

  try {
    const startPage = await getCursor(instance);
    // A cursor at page 1 starts a fresh pruning pass.
    if (startPage === 1) {
      await setPass(instance, { startedAt: new Date().toISOString(), clean: true });
    }
    const first = await fetchPage(instance, startPage);
    const lastPage = first.lastPage;
    const collected: SenderEmail[] = [...first.data];

    let nextPage = startPage + 1;
    let stoppedForRateLimit = false;
    let hadError = false;
    while (nextPage <= lastPage && Date.now() < deadline) {
      const batchEnd = Math.min(nextPage + CONCURRENT - 1, lastPage);
      const pages: number[] = [];
      for (let p = nextPage; p <= batchEnd; p++) pages.push(p);
      const results = await Promise.allSettled(pages.map((p) => fetchPage(instance, p)));
      let sawRateLimit = false;
      for (const r of results) {
        if (r.status === "fulfilled") {
          collected.push(...r.value.data);
        } else {
          const reasonStr = String(r.reason);
          if (reasonStr.includes("429")) sawRateLimit = true;
          else {
            hadError = true;
            console.error(`[cron/deliverability:${instance}] page fetch failed:`, r.reason);
          }
        }
      }
      if (sawRateLimit) {
        stoppedForRateLimit = true;
        console.warn(`[cron/deliverability:${instance}] Bison rate-limited, pausing this run at page ${nextPage}`);
        break;
      }
      nextPage = batchEnd + 1;
      if (nextPage <= lastPage && Date.now() < deadline) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    const completedFullPass = nextPage > lastPage && !stoppedForRateLimit;

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
    for (let i = 0; i < domainRows.length; i += 500) {
      const { error } = await supabase
        .from("deliverability_domains")
        .upsert(domainRows.slice(i, i + 500), { onConflict: "instance,domain", ignoreDuplicates: true });
      if (error) console.error(`[cron/deliverability:${instance}] domain upsert failed:`, error.message);
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
    for (let i = 0; i < inboxRows.length; i += 500) {
      const { error } = await supabase
        .from("deliverability_inboxes")
        .upsert(inboxRows.slice(i, i + 500), { onConflict: "instance,id", ignoreDuplicates: false });
      if (error) {
        hadError = true;
        console.error(`[cron/deliverability:${instance}] inbox upsert failed:`, error.message);
      }
    }

    // Advance cursor; prune stale rows + rebuild stats after a full pass.
    let statsRebuilt = false;
    let pruned = 0;
    if (completedFullPass) {
      await setCursor(instance, 1);

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
      await setCursor(instance, nextPage);
      // Carry an error forward so the run that completes the pass skips pruning.
      if (hadError) {
        const pass = await getPass(instance);
        if (pass && pass.clean) await setPass(instance, { ...pass, clean: false });
      }
    }

    const durationMs = Date.now() - t0;
    console.log(
      `[cron/deliverability:${instance}] pages=${startPage}-${nextPage - 1}/${lastPage} inboxes=${inboxRows.length} domains=${domainRows.length} fullPass=${completedFullPass} pruned=${pruned} statsRebuilt=${statsRebuilt} duration=${durationMs}ms`,
    );
    return NextResponse.json({
      instance,
      startPage,
      endPage: nextPage - 1,
      lastPage,
      inboxes: inboxRows.length,
      domains: domainRows.length,
      completedFullPass,
      pruned,
      statsRebuilt,
      nextCursor: completedFullPass ? 1 : nextPage,
      durationMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cron deliverability sync failed";
    console.error(`[cron/deliverability:${instance}]`, message);
    return NextResponse.json({ error: message, instance }, { status: 500 });
  }
}
