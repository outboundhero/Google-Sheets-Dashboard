import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

const API_BASE = "https://app.outboundhero.co/api";
const API_KEY = process.env.OUTBOUNDHERO_API_KEY!;
// 15 per page is the API max — delay between requests to avoid rate limiting
const PER_PAGE = 15;
const REQUEST_DELAY_MS = 300;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  try {
    const { startPage = 1, pagesPerChunk = 5 } = await request.json().catch(() => ({}));
    const supabase = getSupabaseAdmin();

    // Fetch the first page to know total pages
    const first = await fetchPage(startPage);
    const { lastPage } = first;
    let allInboxes: SenderEmail[] = [...first.data];

    // Fetch remaining pages in this chunk (with delay between each)
    for (let p = startPage + 1; p < startPage + pagesPerChunk && p <= lastPage; p++) {
      await delay(REQUEST_DELAY_MS);
      const { data } = await fetchPage(p);
      allInboxes = allInboxes.concat(data);
    }

    // Group by domain
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

    // Upsert domains
    const domainRows = Object.entries(domainMap).map(([domain, { inboxes, earliestCreatedAt }]) => ({
      domain,
      inbox_count: inboxes.length,
      domain_created_at: earliestCreatedAt,
      synced_at: new Date().toISOString(),
    }));

    if (domainRows.length > 0) {
      const { error: domainErr } = await supabase
        .from("deliverability_domains")
        .upsert(domainRows, { onConflict: "domain", ignoreDuplicates: false });
      if (domainErr) throw domainErr;
    }

    // Upsert inboxes
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

    if (inboxRows.length > 0) {
      const { error: inboxErr } = await supabase
        .from("deliverability_inboxes")
        .upsert(inboxRows, { onConflict: "id", ignoreDuplicates: false });
      if (inboxErr) throw inboxErr;
    }

    // Update domain inbox_count to reflect total in DB (accumulate across chunks)
    // Re-aggregate from DB for touched domains
    const touchedDomains = [...new Set(inboxRows.map((r) => r.domain))];
    for (const domain of touchedDomains) {
      const { count } = await supabase
        .from("deliverability_inboxes")
        .select("*", { count: "exact", head: true })
        .eq("domain", domain);
      if (count !== null) {
        await supabase
          .from("deliverability_domains")
          .update({ inbox_count: count })
          .eq("domain", domain);
      }
    }

    const nextPage = startPage + pagesPerChunk;
    const complete = nextPage > lastPage;

    return NextResponse.json({
      synced: allInboxes.length,
      startPage,
      nextPage: complete ? null : nextPage,
      lastPage,
      complete,
      domains: domainRows.length,
    });
  } catch (error) {
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
