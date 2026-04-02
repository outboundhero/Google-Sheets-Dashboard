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
  // Fetch page 1 to get lastPage count
  const firstRes = await fetch(`${API_BASE}/campaigns?page=1&per_page=100`, { headers, cache: "no-store" });
  if (!firstRes.ok) throw new Error(`API error: ${firstRes.status}`);
  const firstJson = await firstRes.json();
  const lastPage = firstJson.meta?.last_page || 1;
  const allRaw: Record<string, unknown>[] = [...(firstJson.data || [])];

  // Fetch remaining pages concurrently in batches of 10
  if (lastPage > 1) {
    const pages = Array.from({ length: lastPage - 1 }, (_, i) => i + 2);
    for (let i = 0; i < pages.length; i += 10) {
      const batch = pages.slice(i, i + 10);
      const results = await Promise.allSettled(
        batch.map((p) =>
          fetch(`${API_BASE}/campaigns?page=${p}&per_page=100`, { headers, cache: "no-store" })
            .then((r) => r.json())
            .then((j) => j.data || [])
        )
      );
      for (const r of results) {
        if (r.status === "fulfilled") allRaw.push(...r.value);
      }
    }
  }

  for (const c of allRaw) {
    const name = c.name as string;
    const colonIdx = name.indexOf(":");
    const clientTag = colonIdx > 0 ? name.substring(0, colonIdx).trim() : "";
    const totalLeads = (c.total_leads as number) || 0;
    const contacted = (c.total_leads_contacted as number) || 0;
    allCampaigns.push({
      id: c.id as number,
      name,
      status: c.status as string,
      client_tag: clientTag,
      total_leads: totalLeads,
      total_leads_contacted: contacted,
      remaining_leads: totalLeads - contacted,
      emails_sent: (c.emails_sent as number) || 0,
      replied: (c.replied as number) || 0,
      unique_replies: (c.unique_replies as number) || 0,
      bounced: (c.bounced as number) || 0,
      opened: (c.opened as number) || 0,
      unique_opens: (c.unique_opens as number) || 0,
      interested: (c.interested as number) || 0,
      unsubscribed: (c.unsubscribed as number) || 0,
      completion_percentage: (c.completion_percentage as number) || 0,
      created_at: c.created_at as string,
      updated_at: c.updated_at as string,
    });
  }
  return allCampaigns;
}

// GET — fetch campaigns, filtered to active clients only
export async function GET() {
  try {
    // Get active client tags from Google Sheet (exclude churned clients with past churn date)
    const tracker = await getClientTrackerData().catch(() => []);
    const now = new Date();
    const activeClientTags = tracker
      .filter((r) => {
        if (r.status.trim().toLowerCase() !== "active") return false;
        // Exclude if churn date is in the past
        if (r.churnDate) {
          const d = new Date(r.churnDate);
          if (!isNaN(d.getTime()) && d <= now) return false;
        }
        return true;
      })
      .flatMap((r) => r.clientAbbr.split(/\s*&\s*/).map((a) => a.trim()))
      .filter(Boolean);

    // Case-insensitive lookup set (store uppercase keys, compare uppercase)
    const activeClientsUpper = new Set(activeClientTags.map((t) => t.toUpperCase()));

    console.log("[CAMPAIGNS] Active client tags from tracker:", activeClientTags);

    // Try Supabase first, fall back to API
    let campaigns = await getFromSupabase();
    if (!campaigns) {
      campaigns = await fetchFromAPI();
    }

    // Collect all unique campaign client_tags for debugging
    const allCampaignTags = new Set(campaigns.map((c) => c.client_tag).filter(Boolean));
    const missingTags = [...allCampaignTags].filter((t) => !activeClientsUpper.has(t.toUpperCase()));
    if (missingTags.length > 0) {
      console.log("[CAMPAIGNS] Campaign tags NOT in active clients (will be filtered out):", missingTags);
    }

    // Filter to active clients only (case-insensitive match)
    const filtered = campaigns
      .filter((c) => !c.client_tag || activeClientsUpper.has(c.client_tag.toUpperCase()))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return NextResponse.json({
      campaigns: filtered,
      activeClients: activeClientTags.sort(),
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
