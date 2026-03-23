import { NextResponse } from "next/server";
import { syncChunk } from "@/lib/sync-leads";
import { getConfig } from "@/lib/sheets-config";
import { getSupabaseAdmin } from "@/lib/supabase";

const DELIVERABILITY_API = "https://app.outboundhero.co/api";
const DELIVERABILITY_KEY = process.env.OUTBOUNDHERO_API_KEY!;

async function syncDeliverabilityPage(page: number) {
  const res = await fetch(`${DELIVERABILITY_API}/sender-emails?page=${page}&per_page=15`, {
    headers: { Authorization: `Bearer ${DELIVERABILITY_KEY}` },
    cache: "no-store",
  });
  if (!res.ok) return { data: [], lastPage: 0 };
  const json = await res.json();
  const payload = Array.isArray(json) ? json[0] : json;
  return { data: payload.data || [], lastPage: payload.meta?.last_page || 1 };
}

async function runDeliverabilitySync(budget: number) {
  const supabase = getSupabaseAdmin();
  // Fetch the newest 10 pages (API returns newest first) to keep fresh data
  const PAGES_TO_SYNC = 10;
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let synced = 0;

  for (let page = 1; page <= PAGES_TO_SYNC && Date.now() < budget; page++) {
    if (page > 1) await delay(400);
    const { data } = await syncDeliverabilityPage(page);
    if (!data.length) break;

    // Group by domain
    const domainMap: Record<string, { inboxes: typeof data; earliest: string }> = {};
    for (const inbox of data) {
      const domain = inbox.email?.split("@")[1]?.toLowerCase();
      if (!domain) continue;
      if (!domainMap[domain]) domainMap[domain] = { inboxes: [], earliest: inbox.created_at };
      domainMap[domain].inboxes.push(inbox);
      if (inbox.created_at < domainMap[domain].earliest) domainMap[domain].earliest = inbox.created_at;
    }

    // Upsert domains
    const domainRows = Object.entries(domainMap).map(([domain, { inboxes, earliest }]) => ({
      domain,
      inbox_count: inboxes.length,
      domain_created_at: earliest,
      synced_at: new Date().toISOString(),
    }));
    if (domainRows.length) {
      await supabase.from("deliverability_domains").upsert(domainRows, { onConflict: "domain", ignoreDuplicates: false });
    }

    // Upsert inboxes
    const inboxRows = data
      .filter((i: { email?: string }) => i.email?.includes("@"))
      .map((i: { id: number; name: string; email: string; status: string; type: string; daily_limit: number; warmup_enabled: boolean; tags: unknown[]; emails_sent_count: number; total_replied_count: number; total_opened_count: number; bounced_count: number; created_at: string; updated_at: string }) => ({
        id: i.id,
        name: i.name,
        email: i.email,
        domain: i.email.split("@")[1]?.toLowerCase(),
        status: i.status,
        type: i.type,
        daily_limit: i.daily_limit,
        warmup_enabled: i.warmup_enabled,
        tags: i.tags,
        emails_sent_count: i.emails_sent_count,
        total_replied_count: i.total_replied_count,
        total_opened_count: i.total_opened_count,
        bounced_count: i.bounced_count,
        created_at: i.created_at,
        updated_at: i.updated_at,
        synced_at: new Date().toISOString(),
      }));
    if (inboxRows.length) {
      await supabase.from("deliverability_inboxes").upsert(inboxRows, { onConflict: "id", ignoreDuplicates: false });
      synced += inboxRows.length;
    }
  }
  return synced;
}

export const maxDuration = 60;

// Cron syncs as many sheets as possible within timeout
// Multiple cron runs will cover all sheets over time
export async function GET() {
  try {
    const config = await getConfig();
    const totalSheets = config.sheets.length;
    let offset = 0;
    let totalSynced = 0;
    let totalErrors = 0;

    // Process chunks until done or approaching timeout
    const startTime = Date.now();
    while (offset < totalSheets && Date.now() - startTime < 45000) {
      const result = await syncChunk(offset);
      totalSynced += result.sheetsSuccess;
      totalErrors += result.sheetsError;
      offset = result.nextOffset || totalSheets;
    }

    const deliverabilityBudget = startTime + 50000;
    const deliverabilityInboxes = await runDeliverabilitySync(deliverabilityBudget).catch(() => 0);

    // Sync campaigns (fast — just fetches campaign list)
    let campaignsSynced = 0;
    try {
      const campRes = await fetch(`${DELIVERABILITY_API.replace('/api', '')}/api/campaigns?page=1&per_page=100`, {
        headers: { Authorization: `Bearer ${DELIVERABILITY_KEY}` },
        cache: "no-store",
      });
      if (campRes.ok) {
        const campJson = await campRes.json();
        const lastPage = campJson.meta?.last_page || 1;
        const allCampaigns: Record<string, unknown>[] = [...(campJson.data || [])];
        for (let p = 2; p <= lastPage && Date.now() - startTime < 55000; p++) {
          const r = await fetch(`${DELIVERABILITY_API.replace('/api', '')}/api/campaigns?page=${p}&per_page=100`, {
            headers: { Authorization: `Bearer ${DELIVERABILITY_KEY}` },
            cache: "no-store",
          });
          if (r.ok) {
            const j = await r.json();
            allCampaigns.push(...(j.data || []));
          }
        }
        const supabase = getSupabaseAdmin();
        const rows = allCampaigns.map((c) => {
          const name = c.name as string;
          const colonIdx = name.indexOf(":");
          const totalLeads = (c.total_leads as number) || 0;
          const contacted = (c.total_leads_contacted as number) || 0;
          return {
            id: c.id, name, status: c.status,
            client_tag: colonIdx > 0 ? name.substring(0, colonIdx).trim() : "",
            total_leads: totalLeads, total_leads_contacted: contacted,
            remaining_leads: totalLeads - contacted,
            emails_sent: c.emails_sent || 0, replied: c.replied || 0,
            unique_replies: c.unique_replies || 0, bounced: c.bounced || 0,
            opened: c.opened || 0, unique_opens: c.unique_opens || 0,
            interested: c.interested || 0, unsubscribed: c.unsubscribed || 0,
            completion_percentage: c.completion_percentage || 0,
            created_at: c.created_at, updated_at: c.updated_at,
            synced_at: new Date().toISOString(),
          };
        });
        for (let i = 0; i < rows.length; i += 500) {
          await supabase.from("campaigns").upsert(rows.slice(i, i + 500), { onConflict: "id", ignoreDuplicates: false });
        }
        campaignsSynced = rows.length;
      }
    } catch { /* ignore campaign sync errors in cron */ }

    return NextResponse.json({
      totalSynced,
      totalErrors,
      totalSheets,
      complete: offset >= totalSheets,
      deliverabilityInboxes,
      campaignsSynced,
      durationMs: Date.now() - startTime,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cron sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
