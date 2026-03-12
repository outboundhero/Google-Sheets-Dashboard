import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export async function GET() {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.rpc("get_unique_inbox_tags");
    if (error) throw error;
    const tags: string[] = (data || []).map((row: { tag_name: string }) => row.tag_name).filter(Boolean);
    return NextResponse.json(tags);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
