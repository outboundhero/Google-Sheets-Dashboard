import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

/**
 * GET /api/reconnect-log
 * Recent rows from `reconnect_tag_log` — every tag-restore the reconnect
 * webhook has handled. Powers the "Tag Restore Log" card on Settings.
 */
export async function GET() {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("reconnect_tag_log")
      .select("*")
      .order("occurred_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);

    const events = data || [];
    const counts = { ok: 0, skipped: 0, failed: 0 };
    let tagsRestored = 0;
    for (const e of events) {
      if (e.status === "ok") counts.ok++;
      else if (e.status === "failed") counts.failed++;
      else counts.skipped++;
      tagsRestored += e.tags_restored || 0;
    }

    return NextResponse.json({ events, counts, tagsRestored });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
