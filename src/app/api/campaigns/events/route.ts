import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

// GET /api/campaigns/events — campaign history (§29). Filter by a specific
// campaign (?instance=&campaignId=) or a client tag (?clientTag=), newest first.
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const instance = url.searchParams.get("instance");
    const campaignId = url.searchParams.get("campaignId");
    const clientTag = url.searchParams.get("clientTag");
    const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);

    const supabase = getSupabaseAdmin();
    let q = supabase.from("campaign_events").select("*").order("created_at", { ascending: false }).limit(limit);
    if (campaignId) q = q.eq("campaign_id", Number(campaignId));
    if (instance) q = q.eq("instance", instance);
    if (clientTag) q = q.eq("client_tag", clientTag.toUpperCase());
    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ events: data || [] });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
