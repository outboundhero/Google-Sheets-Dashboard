import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { resolveInstances } from "@/lib/bison";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const domain = searchParams.get("domain");
    const page = parseInt(searchParams.get("page") || "1", 10);
    const limit = 50;
    const offset = (page - 1) * limit;
    const instances = resolveInstances(searchParams);

    const supabase = getSupabaseAdmin();
    let query = supabase
      .from("deliverability_inboxes")
      .select("id,instance,name,email,domain,status,type,daily_limit,warmup_enabled,tags,emails_sent_count,total_replied_count,bounced_count,created_at", { count: "exact" })
      .in("instance", instances)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (domain) query = query.eq("domain", domain);

    // Support multiple tags (OR logic) via ?tags=tag1,tag2 or legacy ?tag=name
    const tagsParam = searchParams.get("tags") || searchParams.get("tag");
    if (tagsParam) {
      const tagNames = tagsParam.split(",").map((t) => t.trim()).filter(Boolean);
      if (tagNames.length === 1) {
        query = query.contains("tags", JSON.stringify([{ name: tagNames[0] }]));
      } else if (tagNames.length > 1) {
        // OR: inbox must have at least one of the selected tags
        const orFilter = tagNames.map((t) => `tags.cs.${JSON.stringify([{ name: t }])}`).join(",");
        query = query.or(orFilter);
      }
    }

    const { data, error, count } = await query;
    if (error) throw error;
    return NextResponse.json({ inboxes: data || [], total: count || 0, page, limit });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
