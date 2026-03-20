import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export async function GET(request: Request) {
  try {
    const supabase = getSupabaseAdmin();
    const { searchParams } = new URL(request.url);
    const tagsParam = searchParams.get("tags");

    let query = supabase
      .from("deliverability_domains")
      .select("*")
      .order("domain_created_at", { ascending: false, nullsFirst: false })
      .limit(10000);

    if (tagsParam) {
      const tagNames = tagsParam.split(",").map((t) => t.trim()).filter(Boolean);
      if (tagNames.length > 0) {
        query = query.overlaps("tags", tagNames);
      }
    }

    const { data, error } = await query;
    if (error) throw error;
    return NextResponse.json(data || []);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
