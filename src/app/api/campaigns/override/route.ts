import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { isInstanceSlug } from "@/lib/bison-instances";
import { logCampaignEvent } from "@/lib/campaigns/duplication";

// POST /api/campaigns/override — manual corrections (§4 stage, §5 client tag).
// Body: { instance, id, stage_override?, client_tag_override? }. Empty string
// clears the override (reverts to the auto-derived value).
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { instance?: string; id?: number; stage_override?: string; client_tag_override?: string };
    if (!isInstanceSlug(body.instance) || !body.id) return NextResponse.json({ error: "instance + id required" }, { status: 400 });

    const update: Record<string, unknown> = {};
    const detail: string[] = [];
    if (body.stage_override !== undefined) {
      const v = body.stage_override.trim();
      update.stage_override = v || null;
      detail.push(`stage → ${v || "(auto)"}`);
    }
    if (body.client_tag_override !== undefined) {
      const v = body.client_tag_override.trim().toUpperCase();
      update.client_tag_override = v || null;
      detail.push(`client tag → ${v || "(auto)"}`);
    }
    if (Object.keys(update).length === 0) return NextResponse.json({ error: "nothing to update" }, { status: 400 });

    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from("campaigns").update(update).eq("instance", body.instance).eq("id", body.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await logCampaignEvent(supabase, { instance: body.instance, campaignId: body.id, eventType: "reclassified", detail: detail.join(", "), actor: "user" });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
