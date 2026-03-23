import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

const API_BASE = "https://app.outboundhero.co/api";
const API_KEY = process.env.OUTBOUNDHERO_API_KEY!;
const headers = { Authorization: `Bearer ${API_KEY}` };

// GET — fetch campaigns from Supabase (fast)
export async function GET() {
  try {
    const supabase = getSupabaseAdmin();
    const allCampaigns: Record<string, unknown>[] = [];
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from("campaigns")
        .select("*")
        .order("created_at", { ascending: false })
        .range(offset, offset + PAGE - 1);
      if (error) {
        console.error("[CAMPAIGNS] GET error:", error);
        // If table doesn't exist, return empty — user needs to sync first
        return NextResponse.json([]);
      }
      if (!data || data.length === 0) break;
      allCampaigns.push(...data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }
    return NextResponse.json(allCampaigns);
  } catch (error) {
    console.error("[CAMPAIGNS] GET exception:", error);
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST — sync campaigns from EmailBison to Supabase
export async function POST() {
  const t0 = Date.now();
  try {
    const supabase = getSupabaseAdmin();
    let page = 1;
    let total = 0;

    while (true) {
      const res = await fetch(
        `${API_BASE}/campaigns?page=${page}&per_page=100`,
        { headers, cache: "no-store" }
      );
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const json = await res.json();
      const campaigns = json.data || [];

      if (campaigns.length === 0) break;

      const rows = campaigns.map((c: Record<string, unknown>) => {
        const name = c.name as string;
        const colonIdx = name.indexOf(":");
        const clientTag = colonIdx > 0 ? name.substring(0, colonIdx).trim() : "";
        const totalLeads = (c.total_leads as number) || 0;
        const contacted = (c.total_leads_contacted as number) || 0;

        return {
          id: c.id,
          name,
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
          synced_at: new Date().toISOString(),
        };
      });

      const { error } = await supabase
        .from("campaigns")
        .upsert(rows, { onConflict: "id", ignoreDuplicates: false });
      if (error) {
        console.error("[CAMPAIGNS] Upsert error:", error);
        throw new Error(error.message);
      }

      total += campaigns.length;
      const lastPage = json.meta?.last_page || 1;
      if (page >= lastPage) break;
      page++;
    }

    console.log(`[CAMPAIGNS] Synced ${total} campaigns in ${Date.now() - t0}ms`);
    return NextResponse.json({ synced: total });
  } catch (error) {
    console.error(`[CAMPAIGNS] Sync error:`, error);
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message, details: String(error) }, { status: 500 });
  }
}
