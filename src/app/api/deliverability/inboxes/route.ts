import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const domain = searchParams.get("domain");
    const tag = searchParams.get("tag");
    const page = parseInt(searchParams.get("page") || "1", 10);
    const limit = 50;
    const offset = (page - 1) * limit;

    const supabase = getSupabaseAdmin();
    let query = supabase
      .from("deliverability_inboxes")
      .select("id,name,email,domain,status,type,daily_limit,warmup_enabled,tags,emails_sent_count,total_replied_count,bounced_count,created_at", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (domain) query = query.eq("domain", domain);
    if (tag) query = query.contains("tags", JSON.stringify([{ name: tag }]));

    const { data, error, count } = await query;
    if (error) throw error;
    return NextResponse.json({ inboxes: data || [], total: count || 0, page, limit });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
