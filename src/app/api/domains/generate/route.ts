import { NextResponse } from "next/server";
import { generateDomainCandidates } from "@/lib/openai-domains";
import { getSupabaseAdmin } from "@/lib/supabase";

export async function POST() {
  try {
    const candidates = await generateDomainCandidates();
    if (candidates.length === 0) {
      return NextResponse.json({ candidates: [], skippedAlreadyChecked: 0 });
    }

    // Skip domains we've already checked recently — saves Porkbun rate-limit budget.
    const supabase = getSupabaseAdmin();
    const { data: existing } = await supabase
      .from("porkbun_domains")
      .select("domain")
      .in("domain", candidates);
    const seen = new Set((existing || []).map((r) => r.domain as string));
    const fresh = candidates.filter((d) => !seen.has(d));

    return NextResponse.json({
      candidates: fresh,
      skippedAlreadyChecked: candidates.length - fresh.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
