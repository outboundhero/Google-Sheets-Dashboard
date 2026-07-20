import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

// POST /api/domains/queue/remove — dequeue domains that are still 'queued'
// (never removes rows already buying/registered). Body: { domains: string[] }
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const raw = Array.isArray(body?.domains) ? body.domains : [];
    const domains: string[] = raw
      .filter((d: unknown): d is string => typeof d === "string")
      .map((d: string) => d.trim().toLowerCase())
      .filter(Boolean);
    if (domains.length === 0) {
      return NextResponse.json({ error: "domains array required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const { error, count } = await supabase
      .from("porkbun_buy_queue")
      .delete({ count: "exact" })
      .in("domain", domains)
      .eq("status", "queued");
    if (error) throw new Error(error.message);

    return NextResponse.json({ removed: count ?? 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
