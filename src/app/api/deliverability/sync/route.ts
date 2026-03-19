import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

const API_BASE = "https://app.outboundhero.co/api";
const API_KEY = process.env.OUTBOUNDHERO_API_KEY!;
const PER_PAGE = 15;
const CONCURRENT = 30;

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
    const { startPage = 1, pagesPerChunk = 30 } = await request.json().catch(() => ({}));
    const supabase = getSupabaseAdmin();

    // 1. Fetch first page to get lastPage
    const tFetch0 = Date.now();
    const first = await fetchPage(startPage);
    const { lastPage } = first;
    let allInboxes: SenderEmail[] = [...first.data];
    console.log(`[SYNC] Page ${startPage} fetched in ${Date.now() - tFetch0}ms — lastPage=${lastPage}, got ${first.data.length} inboxes`);

    // 2. Fetch remaining pages concurrently
    const endPage = Math.min(startPage + pagesPerChunk - 1, lastPage);
    const remainingPages: number[] = [];
    for (let p = startPage + 1; p <= endPage; p++) remainingPages.push(p);

    const tFetchAll = Date.now();
    for (let i = 0; i < remainingPages.length; i += CONCURRENT) {
      const batch = remainingPages.slice(i, i + CONCURRENT);
      const tBatch = Date.now();
      const results = await Promise.allSettled(batch.map((p) => fetchPage(p)));
      let batchInboxes = 0;
      let failed = 0;
      for (const r of results) {
        if (r.status === "fulfilled") {
          allInboxes = allInboxes.concat(r.value.data);
          batchInboxes += r.value.data.length;
        } else {
          failed++;
        }
      }
      console.log(`[SYNC] Batch pages ${batch[0]}-${batch[batch.length - 1]}: ${batchInboxes} inboxes in ${Date.now() - tBatch}ms${failed ? ` (${failed} failed)` : ""}`);
    }
    console.log(`[SYNC] All ${endPage - startPage + 1} pages fetched: ${allInboxes.length} inboxes in ${Date.now() - tFetchAll}ms`);

    // 3. Group by domain
    const tGroup = Date.now();
    const isOutlook = (type: string) => /microsoft|outlook/i.test(type);
    const isGoogle = (type: string) => /google|gmail/i.test(type);
    const domainMap: Record<string, { inboxes: SenderEmail[]; earliestCreatedAt: string }> = {};
    for (const inbox of allInboxes) {
      const domain = inbox.email.split("@")[1]?.toLowerCase();
      if (!domain) continue;
      if (!domainMap[domain]) domainMap[domain] = { inboxes: [], earliestCreatedAt: inbox.created_at };
      domainMap[domain].inboxes.push(inbox);
      if (inbox.created_at < domainMap[domain].earliestCreatedAt) {
        domainMap[domain].earliestCreatedAt = inbox.created_at;
      }
    }

    const domainRows = Object.entries(domainMap).map(([domain, { inboxes, earliestCreatedAt }]) => {
      const tagSet = new Set<string>();
      let totalSent = 0, totalReplied = 0, totalBounced = 0, outlookCount = 0, googleCount = 0;
      for (const inbox of inboxes) {
        if (Array.isArray(inbox.tags)) {
          for (const t of inbox.tags) { if (t.name) tagSet.add(t.name); }
        }
        totalSent += inbox.emails_sent_count || 0;
        totalReplied += inbox.total_replied_count || 0;
        totalBounced += inbox.bounced_count || 0;
        if (isOutlook(inbox.type)) outlookCount++;
        if (isGoogle(inbox.type)) googleCount++;
      }
      return {
        domain,
        inbox_count: inboxes.length,
        domain_created_at: earliestCreatedAt,
        tags: Array.from(tagSet).sort(),
        total_sent: totalSent,
        total_replied: totalReplied,
        total_bounced: totalBounced,
        outlook_count: outlookCount,
        google_count: googleCount,
        synced_at: new Date().toISOString(),
      };
    });
    console.log(`[SYNC] Grouped into ${domainRows.length} domains in ${Date.now() - tGroup}ms`);

    // 4. Upsert domains
    const tDomainUpsert = Date.now();
    if (domainRows.length > 0) {
      const { error: domainErr } = await supabase
        .from("deliverability_domains")
        .upsert(domainRows, { onConflict: "domain", ignoreDuplicates: false });
      if (domainErr) throw domainErr;
    }
    console.log(`[SYNC] Domain upsert: ${domainRows.length} rows in ${Date.now() - tDomainUpsert}ms`);

    // 5. Upsert inboxes
    const tInboxUpsert = Date.now();
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

    // Upsert in batches of 500 to avoid payload limits
    for (let i = 0; i < inboxRows.length; i += 500) {
      const batch = inboxRows.slice(i, i + 500);
      const { error: inboxErr } = await supabase
        .from("deliverability_inboxes")
        .upsert(batch, { onConflict: "id", ignoreDuplicates: false });
      if (inboxErr) throw inboxErr;
    }
    console.log(`[SYNC] Inbox upsert: ${inboxRows.length} rows in ${Date.now() - tInboxUpsert}ms`);

    const nextPage = startPage + pagesPerChunk;
    const complete = nextPage > lastPage;

    const totalMs = Date.now() - t0;
    console.log(`[SYNC] DONE chunk pages ${startPage}-${endPage}: ${allInboxes.length} inboxes, ${domainRows.length} domains in ${totalMs}ms (${(totalMs / 1000).toFixed(1)}s)`);

    return NextResponse.json({
      synced: allInboxes.length,
      startPage,
      nextPage: complete ? null : nextPage,
      lastPage,
      complete,
      domains: domainRows.length,
    });
  } catch (error) {
    console.error(`[SYNC] ERROR after ${Date.now() - t0}ms:`, error);
    const message = error instanceof Error ? error.message : "Sync failed";
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
