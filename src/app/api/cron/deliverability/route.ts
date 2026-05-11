import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

const API_BASE = "https://app.outboundhero.co/api";
const API_KEY = process.env.OUTBOUNDHERO_API_KEY!;
const PER_PAGE = 15;
const CONCURRENT = 10;
const CURSOR_KEY = "cron:deliverability:cursor";
const STATS_REBUILD_GRACE_MS = 8000;

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

async function getCursor(): Promise<number> {
  const redis = getRedis();
  if (!redis) return 1;
  const val = await redis.get<number>(CURSOR_KEY);
  return typeof val === "number" && val > 0 ? val : 1;
}

async function setCursor(page: number): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.set(CURSOR_KEY, page);
}

async function fetchPage(page: number): Promise<{ data: SenderEmail[]; lastPage: number }> {
  const res = await fetch(`${API_BASE}/sender-emails?page=${page}&per_page=${PER_PAGE}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Outboundhero ${res.status} on page ${page}`);
  const json = await res.json();
  const payload = Array.isArray(json) ? json[0] : json;
  return { data: payload.data || [], lastPage: payload.meta?.last_page || 1 };
}

export const maxDuration = 60;

export async function GET() {
  const t0 = Date.now();
  const deadline = t0 + 60_000 - STATS_REBUILD_GRACE_MS;
  const supabase = getSupabaseAdmin();

  try {
    const startPage = await getCursor();
    const first = await fetchPage(startPage);
    const lastPage = first.lastPage;
    const collected: SenderEmail[] = [...first.data];

    let nextPage = startPage + 1;
    while (nextPage <= lastPage && Date.now() < deadline) {
      const batchEnd = Math.min(nextPage + CONCURRENT - 1, lastPage);
      const pages: number[] = [];
      for (let p = nextPage; p <= batchEnd; p++) pages.push(p);
      const results = await Promise.allSettled(pages.map((p) => fetchPage(p)));
      for (const r of results) {
        if (r.status === "fulfilled") collected.push(...r.value.data);
        else console.error("[cron/deliverability] page fetch failed:", r.reason);
      }
      nextPage = batchEnd + 1;
    }

    const completedFullPass = nextPage > lastPage;

    // Upsert domains (insert-only — don't clobber inbox_count which is owned by rebuild_domain_stats)
    const domainEarliest = new Map<string, string>();
    for (const inbox of collected) {
      const domain = inbox.email?.split("@")[1]?.toLowerCase();
      if (!domain) continue;
      const existing = domainEarliest.get(domain);
      if (!existing || inbox.created_at < existing) domainEarliest.set(domain, inbox.created_at);
    }
    const domainRows = Array.from(domainEarliest.entries()).map(([domain, created_at]) => ({
      domain,
      domain_created_at: created_at,
      warmup_status: "open",
      synced_at: new Date().toISOString(),
    }));
    for (let i = 0; i < domainRows.length; i += 500) {
      const { error } = await supabase
        .from("deliverability_domains")
        .upsert(domainRows.slice(i, i + 500), { onConflict: "domain", ignoreDuplicates: true });
      if (error) console.error("[cron/deliverability] domain upsert failed:", error.message);
    }

    // Upsert inboxes
    const inboxRows = collected
      .filter((i) => i.email?.includes("@"))
      .map((i) => ({
        id: i.id,
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
        .upsert(inboxRows.slice(i, i + 500), { onConflict: "id", ignoreDuplicates: false });
      if (error) console.error("[cron/deliverability] inbox upsert failed:", error.message);
    }

    // Advance cursor; rebuild stats only after a full pass.
    let statsRebuilt = false;
    if (completedFullPass) {
      await setCursor(1);
      const { error: rpcErr } = await supabase.rpc("rebuild_domain_stats");
      if (rpcErr) console.error("[cron/deliverability] rebuild_domain_stats failed:", rpcErr.message);
      else statsRebuilt = true;
    } else {
      await setCursor(nextPage);
    }

    const durationMs = Date.now() - t0;
    console.log(
      `[cron/deliverability] pages=${startPage}-${nextPage - 1}/${lastPage} inboxes=${inboxRows.length} domains=${domainRows.length} fullPass=${completedFullPass} statsRebuilt=${statsRebuilt} duration=${durationMs}ms`
    );
    return NextResponse.json({
      startPage,
      endPage: nextPage - 1,
      lastPage,
      inboxes: inboxRows.length,
      domains: domainRows.length,
      completedFullPass,
      statsRebuilt,
      nextCursor: completedFullPass ? 1 : nextPage,
      durationMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cron deliverability sync failed";
    console.error("[cron/deliverability]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
