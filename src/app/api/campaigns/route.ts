import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getClientTrackerData } from "@/lib/google-sheets";

const API_BASE = "https://app.outboundhero.co/api";
const API_KEY = process.env.OUTBOUNDHERO_API_KEY!;
const headers = { Authorization: `Bearer ${API_KEY}` };

export interface CampaignData {
  id: number;
  name: string;
  status: string;
  client_tag: string;
  total_leads: number;
  total_leads_contacted: number;
  remaining_leads: number;
  emails_sent: number;
  replied: number;
  unique_replies: number;
  bounced: number;
  opened: number;
  unique_opens: number;
  interested: number;
  unsubscribed: number;
  completion_percentage: number;
  created_at: string;
  updated_at: string;
}

// Try Supabase first, fall back to direct API
async function getFromSupabase(): Promise<CampaignData[] | null> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("campaigns")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) return null; // table doesn't exist
    // Table exists, fetch all
    const all: CampaignData[] = [];
    let offset = 0;
    while (true) {
      const { data: page } = await supabase
        .from("campaigns")
        .select("*")
        .order("created_at", { ascending: false })
        .range(offset, offset + 999);
      if (!page || page.length === 0) break;
      all.push(...(page as CampaignData[]));
      if (page.length < 1000) break;
      offset += 1000;
    }
    return all.length > 0 ? all : null;
  } catch {
    return null;
  }
}

async function fetchFromAPI(): Promise<CampaignData[]> {
  const allCampaigns: CampaignData[] = [];
  let page = 1;
  while (true) {
    const res = await fetch(
      `${API_BASE}/campaigns?page=${page}&per_page=100`,
      { headers, cache: "no-store" }
    );
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const json = await res.json();
    const campaigns = json.data || [];
    for (const c of campaigns) {
      const colonIdx = (c.name as string).indexOf(":");
      const clientTag = colonIdx > 0 ? (c.name as string).substring(0, colonIdx).trim() : "";
      const totalLeads = c.total_leads || 0;
      const contacted = c.total_leads_contacted || 0;
      allCampaigns.push({
        id: c.id,
        name: c.name,
        status: c.status,
        client_tag: clientTag,
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
      });
    }
    const lastPage = json.meta?.last_page || 1;
    if (page >= lastPage) break;
    page++;
  }
  return allCampaigns;
}

// GET — fetch campaigns, filtered to active clients only
export async function GET() {
  try {
    // Get active client tags from Google Sheet (exclude churned clients with past churn date)
    const tracker = await getClientTrackerData().catch(() => []);
    const now = new Date();
    const activeClients = new Set(
      tracker
        .filter((r) => {
          if (r.status.trim().toLowerCase() !== "active") return false;
          // Exclude if churn date is in the past
          if (r.churnDate) {
            const d = new Date(r.churnDate);
            if (!isNaN(d.getTime()) && d <= now) return false;
          }
          return true;
        })
        .flatMap((r) => r.clientAbbr.split(" & ").map((a) => a.trim()))
        .filter(Boolean)
    );

    // Try Supabase first, fall back to API
    let campaigns = await getFromSupabase();
    if (!campaigns) {
      campaigns = await fetchFromAPI();
    }

    // Filter to active clients only
    const filtered = campaigns
      .filter((c) => !c.client_tag || activeClients.has(c.client_tag))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return NextResponse.json({
      campaigns: filtered,
      activeClients: Array.from(activeClients).sort(),
    });
  } catch (error) {
    console.error("[CAMPAIGNS] Error:", error);
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST — sync from EmailBison API (try to save to Supabase if table exists)
export async function POST() {
  const t0 = Date.now();
  try {
    const campaigns = await fetchFromAPI();

    // Try to save to Supabase
    try {
      const supabase = getSupabaseAdmin();
      for (let i = 0; i < campaigns.length; i += 500) {
        await supabase
          .from("campaigns")
          .upsert(
            campaigns.slice(i, i + 500).map((c) => ({ ...c, synced_at: new Date().toISOString() })),
            { onConflict: "id", ignoreDuplicates: false }
          );
      }
    } catch {
      // Supabase table might not exist — that's okay
    }

    console.log(`[CAMPAIGNS] Synced ${campaigns.length} in ${Date.now() - t0}ms`);
    return NextResponse.json({ synced: campaigns.length });
  } catch (error) {
    console.error("[CAMPAIGNS] Sync error:", error);
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
