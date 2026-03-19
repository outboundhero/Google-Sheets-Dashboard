import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

const API_BASE = "https://app.outboundhero.co/api";
const API_KEY = process.env.OUTBOUNDHERO_API_KEY!;
const PER_PAGE = 15;
const CONCURRENT = 10; // fetch 10 pages at once
const BATCH_DELAY_MS = 50; // minimal delay between concurrent batches

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
    const { startPage = 1, pagesPerChunk = 50 } = await request.json().catch(() => ({}));
    const supabase = getSupabaseAdmin();

    // Fetch first page to get lastPage
    const first = await fetchPage(startPage);
    const { lastPage } = first;
    let allInboxes: SenderEmail[] = [...first.data];

    // Fetch remaining pages in concurrent batches of CONCURRENT
    const endPage = Math.min(startPage + pagesPerChunk - 1, lastPage);
    const remainingPages: number[] = [];
    for (let p = startPage + 1; p <= endPage; p++) {
      remainingPages.push(p);
    }

    for (let i = 0; i < remainingPages.length; i += CONCURRENT) {
      const batch = remainingPages.slice(i, i + CONCURRENT);
      const results = await Promise.allSettled(batch.map((p) => fetchPage(p)));
      for (const r of results) {
        if (r.status === "fulfilled") allInboxes = allInboxes.concat(r.value.data);
      }
      if (i + CONCURRENT < remainingPages.length) await delay(BATCH_DELAY_MS);
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

    // Upsert domains with aggregated tags + stats
    const isOutlook = (type: string) => /microsoft|outlook/i.test(type);
    const isGoogle = (type: string) => /google|gmail/i.test(type);

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

    // Re-aggregate domain stats from DB (fixes counts across chunks)
    const touchedDomains = [...new Set(inboxRows.map((r) => r.domain))];
    for (const dom of touchedDomains) {
      const { data: domInboxes } = await supabase
        .from("deliverability_inboxes")
        .select("emails_sent_count,total_replied_count,bounced_count,type")
        .eq("domain", dom);
      if (domInboxes) {
        let sent = 0, replied = 0, bounced = 0, ol = 0, g = 0;
        for (const i of domInboxes) {
          sent += i.emails_sent_count || 0;
          replied += i.total_replied_count || 0;
          bounced += i.bounced_count || 0;
          if (isOutlook(i.type || "")) ol++;
          if (isGoogle(i.type || "")) g++;
        }
        await supabase.from("deliverability_domains").update({
          inbox_count: domInboxes.length,
          total_sent: sent,
          total_replied: replied,
          total_bounced: bounced,
          outlook_count: ol,
          google_count: g,
        }).eq("domain", dom);
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

// DELETE — cleanup stale records after a full sync
// Removes inboxes/domains from Supabase that no longer exist in EmailBison
export async function DELETE(request: Request) {
  try {
    const { syncStartedAt } = await request.json().catch(() => ({}));
    if (!syncStartedAt) {
      return NextResponse.json({ error: "syncStartedAt required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const isOutlook = (type: string) => /microsoft|outlook/i.test(type);
    const isGoogle = (type: string) => /google|gmail/i.test(type);

    // 1. Delete inboxes not touched during this sync
    const { data: staleInboxes } = await supabase
      .from("deliverability_inboxes")
      .select("id, domain")
      .lt("synced_at", syncStartedAt);

    const staleCount = staleInboxes?.length || 0;

    if (staleCount > 0) {
      const staleIds = staleInboxes!.map((i) => i.id);
      // Delete in batches of 500 (Supabase limit)
      for (let i = 0; i < staleIds.length; i += 500) {
        await supabase
          .from("deliverability_inboxes")
          .delete()
          .in("id", staleIds.slice(i, i + 500));
      }
    }

    // 2. Re-aggregate ALL domain stats from remaining inboxes
    const { data: allDomains } = await supabase
      .from("deliverability_domains")
      .select("domain");

    let domainsRemoved = 0;

    for (const d of allDomains || []) {
      const { data: remaining } = await supabase
        .from("deliverability_inboxes")
        .select("tags, type, emails_sent_count, total_replied_count, bounced_count")
        .eq("domain", d.domain);

      if (!remaining || remaining.length === 0) {
        // No inboxes left — delete domain
        await supabase.from("deliverability_domains").delete().eq("domain", d.domain);
        domainsRemoved++;
      } else {
        // Re-aggregate stats
        const tagSet = new Set<string>();
        let sent = 0, replied = 0, bounced = 0, ol = 0, g = 0;
        for (const inbox of remaining) {
          if (Array.isArray(inbox.tags)) {
            for (const t of inbox.tags) { if (t.name) tagSet.add(t.name); }
          }
          sent += inbox.emails_sent_count || 0;
          replied += inbox.total_replied_count || 0;
          bounced += inbox.bounced_count || 0;
          if (isOutlook(inbox.type || "")) ol++;
          if (isGoogle(inbox.type || "")) g++;
        }

        await supabase.from("deliverability_domains").update({
          inbox_count: remaining.length,
          tags: Array.from(tagSet).sort(),
          total_sent: sent,
          total_replied: replied,
          total_bounced: bounced,
          outlook_count: ol,
          google_count: g,
        }).eq("domain", d.domain);
      }
    }

    return NextResponse.json({
      staleInboxesRemoved: staleCount,
      domainsRemoved,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cleanup failed";
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
