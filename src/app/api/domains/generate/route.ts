import { NextResponse } from "next/server";
import { generateDomainCandidates } from "@/lib/openai-domains";
import { getSupabaseAdmin } from "@/lib/supabase";

const EXAMPLE_SAMPLE_SIZE = 30;

export async function POST() {
  try {
    const supabase = getSupabaseAdmin();

    // Pull recent .info domains from the user's deliverability inventory as
    // style examples. Sample broadly then pick a random subset.
    const { data: ownedRows } = await supabase
      .from("deliverability_domains")
      .select("domain")
      .ilike("domain", "%.info")
      .order("domain_created_at", { ascending: false, nullsFirst: false })
      .limit(200);
    const owned = (ownedRows || [])
      .map((r) => (r.domain as string)?.toLowerCase())
      .filter((d): d is string => !!d && d.endsWith(".info"));

    const examples: string[] = [];
    const pool = [...owned];
    while (examples.length < EXAMPLE_SAMPLE_SIZE && pool.length > 0) {
      const idx = Math.floor(Math.random() * pool.length);
      examples.push(pool.splice(idx, 1)[0]);
    }

    const candidates = await generateDomainCandidates(examples);
    if (candidates.length === 0) {
      return NextResponse.json({ candidates: [], skippedAlreadyChecked: 0, examplesUsed: examples.length });
    }

    // Skip domains we've already checked previously — saves Porkbun rate-limit budget.
    const { data: existing } = await supabase
      .from("porkbun_domains")
      .select("domain")
      .in("domain", candidates);
    const seen = new Set((existing || []).map((r) => r.domain as string));
    // Also skip anything already in user's deliverability inventory.
    const ownedSet = new Set(owned);
    const fresh = candidates.filter((d) => !seen.has(d) && !ownedSet.has(d));

    return NextResponse.json({
      candidates: fresh,
      skippedAlreadyChecked: candidates.length - fresh.length,
      examplesUsed: examples.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
