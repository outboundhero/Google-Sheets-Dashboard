import { NextResponse } from "next/server";
import { syncChunk } from "@/lib/sync-leads";
import { getConfig } from "@/lib/sheets-config";
import { getSupabaseAdmin } from "@/lib/supabase";
import { syncSheetsToSupabase } from "@/lib/supabase-sheets-sync";

const DELIVERABILITY_API = "https://app.outboundhero.co/api";
const DELIVERABILITY_KEY = process.env.OUTBOUNDHERO_API_KEY!;

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

    // Sync tracked sheets config to Supabase
    await syncSheetsToSupabase().catch((err) =>
      console.error("[cron/sync] Supabase sheets sync failed:", err)
    );

    return NextResponse.json({
      totalSynced,
      totalErrors,
      totalSheets,
      complete: offset >= totalSheets,
      campaignsSynced,
      durationMs: Date.now() - startTime,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cron sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
