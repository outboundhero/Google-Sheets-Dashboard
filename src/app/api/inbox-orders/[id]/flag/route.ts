import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const flagged = body?.flagged === true;

    const supabase = getSupabaseAdmin();
    const { data: updated, error } = await supabase
      .from("inbox_orders")
      .update({ flagged_at: flagged ? new Date().toISOString() : null })
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);

    return NextResponse.json({ order: updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
