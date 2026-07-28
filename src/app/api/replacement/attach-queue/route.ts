import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { maybeDeferReattach, type AttachOutcome } from "@/lib/replacement/attach-queue";

export const maxDuration = 60;

// POST /api/replacement/attach-queue — the runner reports every attach outcome
// here; the server defers an 8h re-attach when needed (failed / rate-limited /
// campaign queued-launching). GET — current queue (admin visibility).
export async function POST(request: Request) {
  try {
    const o = (await request.json()) as AttachOutcome;
    if (!o?.instance || !o?.campaignId || !Array.isArray(o?.domains) || o.domains.length === 0) {
      return NextResponse.json({ error: "instance, campaignId, domains required" }, { status: 400 });
    }
    const deferred = await maybeDeferReattach(o);
    return NextResponse.json({ deferred });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export async function GET() {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("replacement_attach_queue")
      .select("*")
      .order("next_attempt_at", { ascending: true })
      .limit(200);
    if (error) throw new Error(error.message);
    return NextResponse.json({ queue: data || [] });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
