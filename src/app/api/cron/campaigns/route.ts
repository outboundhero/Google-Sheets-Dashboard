import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

const API_BASE = "https://app.outboundhero.co/api";
const API_KEY = process.env.OUTBOUNDHERO_API_KEY!;

export const maxDuration = 60;

interface CampaignPayload {
  id: number;
  name: string;
  status: string;
  total_leads?: number;
  total_leads_contacted?: number;
  emails_sent?: number;
  replied?: number;
  unique_replies?: number;
  bounced?: number;
  opened?: number;
  unique_opens?: number;
  interested?: number;
  unsubscribed?: number;
  completion_percentage?: number;
  created_at: string;
  updated_at: string;
}

export async function GET() {
  const t0 = Date.now();
  const supabase = getSupabaseAdmin();
  const headers = { Authorization: `Bearer ${API_KEY}` };

  try {
    const firstRes = await fetch(`${API_BASE}/campaigns?page=1&per_page=100`, { headers, cache: "no-store" });
    if (!firstRes.ok) {
      return NextResponse.json({ error: `Outboundhero ${firstRes.status} on page 1` }, { status: 502 });
    }
    const firstJson = await firstRes.json();
    const lastPage: number = firstJson.meta?.last_page || 1;
    const all: CampaignPayload[] = [...(firstJson.data || [])];

    for (let p = 2; p <= lastPage && Date.now() - t0 < 55_000; p++) {
      const r = await fetch(`${API_BASE}/campaigns?page=${p}&per_page=100`, { headers, cache: "no-store" });
      if (!r.ok) continue;
      const j = await r.json();
      all.push(...(j.data || []));
    }

    const rows = all.map((c) => {
      const colonIdx = c.name?.indexOf(":") ?? -1;
      const totalLeads = c.total_leads || 0;
      const contacted = c.total_leads_contacted || 0;
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        client_tag: colonIdx > 0 ? c.name.substring(0, colonIdx).trim() : "",
        total_leads: totalLeads,
        total_leads_contacted: contacted,
        remaining_leads: totalLeads - contacted,
        emails_sent: c.emails_sent || 0,
        replied: c.replied || 0,
        unique_replies: c.unique_replies || 0,
        bounced: c.bounced || 0,
        opened: c.opened || 0,
        unique_opens: c.unique_opens || 0,
        interested: c.interested || 0,
        unsubscribed: c.unsubscribed || 0,
        completion_percentage: c.completion_percentage || 0,
        created_at: c.created_at,
        updated_at: c.updated_at,
        synced_at: new Date().toISOString(),
      };
    });

    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase
        .from("campaigns")
        .upsert(rows.slice(i, i + 500), { onConflict: "id", ignoreDuplicates: false });
      if (error) console.error("[cron/campaigns] upsert failed:", error.message);
    }

    const durationMs = Date.now() - t0;
    console.log(`[cron/campaigns] synced=${rows.length} pages=${lastPage} duration=${durationMs}ms`);
    return NextResponse.json({ campaignsSynced: rows.length, pages: lastPage, durationMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    console.error("[cron/campaigns]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
