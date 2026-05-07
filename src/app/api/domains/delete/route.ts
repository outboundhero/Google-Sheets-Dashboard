import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const raw = Array.isArray(body?.domains) ? body.domains : [];
    const domains = raw
      .filter((d: unknown): d is string => typeof d === "string")
      .map((d: string) => d.trim().toLowerCase())
      .filter(Boolean);

    if (domains.length === 0) {
      return NextResponse.json({ error: "domains array required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    // Only delete unregistered ones — never wipe registered/historical records.
    const { error, count } = await supabase
      .from("porkbun_domains")
      .delete({ count: "exact" })
      .in("domain", domains)
      .eq("registered", false);
    if (error) throw new Error(error.message);

    return NextResponse.json({ deleted: count ?? 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
