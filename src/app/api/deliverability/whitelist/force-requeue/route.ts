import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

// POST { clientTag, domains[] } → FORCE re-queue for the next 6:30 AM PT batch,
// overriding the "already sent" dedup.
//
// The normal /whitelist/queue endpoint skips anything already 'sent'
// (ignoreDuplicates), so a plain re-queue is a no-op — which is why a
// wrong/bounced recipient (e.g. K&LCS, Aug 2026) previously needed a manual SQL
// reset. This is the self-serve equivalent: upsert to status='queued',
// sent_at=null regardless of prior status. Recipients are still resolved fresh
// from ReplyRouter at send time, so a corrected CC is picked up automatically.
//
// Admin-only via the standard /api/deliverability/* middleware gate.
export async function POST(request: Request) {
  try {
    const { clientTag, domains } = (await request.json()) as {
      clientTag?: string;
      domains?: string[];
    };
    if (!clientTag || !Array.isArray(domains) || domains.length === 0) {
      return NextResponse.json({ error: "clientTag and domains are required" }, { status: 400 });
    }

    const list = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))];
    if (list.length === 0) {
      return NextResponse.json({ error: "no valid domains" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("whitelist_queue")
      .upsert(
        list.map((domain) => ({ client_tag: clientTag, domain, status: "queued", sent_at: null })),
        { onConflict: "client_tag,domain" },
      )
      .select("domain");
    if (error) throw new Error(error.message);

    return NextResponse.json({ ok: true, clientTag, requeued: data?.length ?? list.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to force re-queue";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
