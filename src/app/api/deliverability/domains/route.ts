import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export async function GET(request: Request) {
  try {
    const supabase = getSupabaseAdmin();
    const { searchParams } = new URL(request.url);
    const tagsParam = searchParams.get("tags");

    // Paginate to get ALL domains (Supabase caps at 1000 per query)
    const allDomains: Record<string, unknown>[] = [];
    const PAGE = 1000;
    let offset = 0;

    while (true) {
      let query = supabase
        .from("deliverability_domains")
        .select("*")
        .order("domain_created_at", { ascending: false, nullsFirst: false })
        .range(offset, offset + PAGE - 1);

      if (tagsParam) {
        const tagNames = tagsParam.split(",").map((t) => t.trim()).filter(Boolean);
        if (tagNames.length > 0) {
          query = query.overlaps("tags", tagNames);
        }
      }

      const { data, error } = await query;
      if (error) throw error;
      if (!data || data.length === 0) break;
      allDomains.push(...data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }

    return NextResponse.json(allDomains);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
