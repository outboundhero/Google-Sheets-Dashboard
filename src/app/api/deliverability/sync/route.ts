import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

const API_BASE = "https://app.outboundhero.co/api";
const API_KEY = process.env.OUTBOUNDHERO_API_KEY!;
const PER_PAGE = 15;
const CONCURRENT = 10;

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
  created_at: string;
  updated_at: string;
}

async function fetchPage(page: number): Promise<{ data: SenderEmail[]; lastPage: number }> {
  const url = `${API_BASE}/sender-emails?page=${page}&per_page=${PER_PAGE}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`API error ${res.status} on page ${page}`);
  const json = await res.json();
  const payload = Array.isArray(json) ? json[0] : json;
  return {
    data: payload.data || [],
    lastPage: payload.meta?.last_page || 1,
  };
}

export async function POST(request: Request) {
  const t0 = Date.now();
  try {
    const { startPage = 1, pagesPerChunk = 20 } = await request.json().catch(() => ({}));
    const supabase = getSupabaseAdmin();

    // 1. Fetch first page
    const first = await fetchPage(startPage);
    const { lastPage } = first;
    let allInboxes: SenderEmail[] = [...first.data];

    // 2. Fetch remaining pages concurrently
    const endPage = Math.min(startPage + pagesPerChunk - 1, lastPage);
    const remainingPages: number[] = [];
    for (let p = startPage + 1; p <= endPage; p++) remainingPages.push(p);

    for (let i = 0; i < remainingPages.length; i += CONCURRENT) {
      const batch = remainingPages.slice(i, i + CONCURRENT);
      const results = await Promise.allSettled(batch.map((p) => fetchPage(p)));
      for (const r of results) {
        if (r.status === "fulfilled") allInboxes = allInboxes.concat(r.value.data);
      }
    }
    const fetchMs = Date.now() - t0;

    // 3. Upsert inboxes only (skip domain aggregation — done separately)
    const tDb = Date.now();
    const inboxRows = allInboxes.map((inbox) => ({
      id: inbox.id,
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
      created_at: inbox.created_at,
      updated_at: inbox.updated_at,
      synced_at: new Date().toISOString(),
    })).filter((r) => r.domain);

    // Ensure domains exist first (minimal upsert — just domain + created_at)
    const domainSet = new Map<string, string>();
    for (const inbox of allInboxes) {
      const domain = inbox.email.split("@")[1]?.toLowerCase();
      if (!domain) continue;
      if (!domainSet.has(domain) || inbox.created_at < domainSet.get(domain)!) {
        domainSet.set(domain, inbox.created_at);
      }
    }
    const minimalDomains = Array.from(domainSet.entries()).map(([domain, created_at]) => ({
      domain,
      domain_created_at: created_at,
      synced_at: new Date().toISOString(),
    }));
    if (minimalDomains.length > 0) {
      await supabase
        .from("deliverability_domains")
        .upsert(minimalDomains, { onConflict: "domain", ignoreDuplicates: true });
    }

    // Upsert inboxes in batches of 500
    for (let i = 0; i < inboxRows.length; i += 500) {
      const batch = inboxRows.slice(i, i + 500);
      const { error: inboxErr } = await supabase
        .from("deliverability_inboxes")
        .upsert(batch, { onConflict: "id", ignoreDuplicates: false });
      if (inboxErr) throw inboxErr;
    }
    const dbMs = Date.now() - tDb;

    const nextPage = startPage + pagesPerChunk;
    const complete = nextPage > lastPage;
    const totalMs = Date.now() - t0;

    console.log(`[SYNC] Pages ${startPage}-${endPage}: ${allInboxes.length} inboxes | fetch=${fetchMs}ms db=${dbMs}ms total=${totalMs}ms`);

    return NextResponse.json({
      synced: allInboxes.length,
      startPage,
      nextPage: complete ? null : nextPage,
      lastPage,
      complete,
      domains: domainSet.size,
    });
  } catch (error) {
    console.error(`[SYNC] ERROR after ${Date.now() - t0}ms:`, error);
    const message = error instanceof Error ? error.message : "Sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// PUT — rebuild all domain stats from inboxes (call after full sync)
export async function PUT() {
  const t0 = Date.now();
  try {
    const supabase = getSupabaseAdmin();
    const isOutlook = (type: string) => /microsoft|outlook/i.test(type);
    const isGoogle = (type: string) => /google|gmail/i.test(type);

    // Get all inboxes grouped by domain
    const { data: allInboxes, error } = await supabase
      .from("deliverability_inboxes")
      .select("domain, tags, type, emails_sent_count, total_replied_count, bounced_count");
    if (error) throw error;

    const domainMap = new Map<string, typeof allInboxes>();
    for (const inbox of allInboxes || []) {
      if (!domainMap.has(inbox.domain)) domainMap.set(inbox.domain, []);
      domainMap.get(inbox.domain)!.push(inbox);
    }

    // Build domain rows
    const domainRows = Array.from(domainMap.entries()).map(([domain, inboxes]) => {
      const tagSet = new Set<string>();
      let sent = 0, replied = 0, bounced = 0, ol = 0, g = 0;
      for (const i of inboxes) {
        if (Array.isArray(i.tags)) {
          for (const t of i.tags) { if (t.name) tagSet.add(t.name); }
        }
        sent += i.emails_sent_count || 0;
        replied += i.total_replied_count || 0;
        bounced += i.bounced_count || 0;
        if (isOutlook(i.type || "")) ol++;
        if (isGoogle(i.type || "")) g++;
      }
      return {
        domain,
        inbox_count: inboxes.length,
        tags: Array.from(tagSet).sort(),
        total_sent: sent,
        total_replied: replied,
        total_bounced: bounced,
        outlook_count: ol,
        google_count: g,
        synced_at: new Date().toISOString(),
      };
    });

    // Upsert in batches
    for (let i = 0; i < domainRows.length; i += 500) {
      await supabase
        .from("deliverability_domains")
        .upsert(domainRows.slice(i, i + 500), { onConflict: "domain", ignoreDuplicates: false });
    }

    console.log(`[SYNC] Domain rebuild: ${domainRows.length} domains from ${allInboxes?.length} inboxes in ${Date.now() - t0}ms`);
    return NextResponse.json({ domains: domainRows.length, inboxes: allInboxes?.length });
  } catch (error) {
    console.error(`[SYNC] Domain rebuild ERROR:`, error);
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET() {
  try {
    const supabase = getSupabaseAdmin();
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
