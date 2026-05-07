import { NextResponse } from "next/server";
import { appendToSecondaryDomainColumn } from "@/lib/google-sheets-secondary-domain";
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

    const result = await appendToSecondaryDomainColumn(domains);

    if (result.added > 0) {
      const supabase = getSupabaseAdmin();
      await supabase
        .from("porkbun_domains")
        .update({ appended_to_sheet: true })
        .in("domain", domains);
    }

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
