import { NextResponse } from "next/server";
import {
  generateDomainCandidates,
  SUPPORTED_TLDS,
  type SupportedTld,
  type GenerationMode,
} from "@/lib/openai-domains";
import { getSupabaseAdmin } from "@/lib/supabase";

const EXAMPLE_SAMPLE_SIZE = 30;

function parseTlds(input: unknown): SupportedTld[] {
  const arr = Array.isArray(input) ? input : [];
  const valid = arr
    .map((t) => (typeof t === "string" ? t.trim().toLowerCase() : ""))
    .map((t) => (t && !t.startsWith(".") ? `.${t}` : t))
    .filter((t): t is SupportedTld => (SUPPORTED_TLDS as readonly string[]).includes(t));
  return Array.from(new Set(valid));
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const mode: GenerationMode = body?.mode === "lookalike" ? "lookalike" : "niche";
    const tlds = parseTlds(body?.tlds);
    const selectedTlds: SupportedTld[] = tlds.length > 0 ? tlds : [".info"];
    const niche = typeof body?.niche === "string" && body.niche.trim() ? body.niche.trim() : "commercial cleaning";
    const seedDomain = typeof body?.seedDomain === "string" ? body.seedDomain.trim().toLowerCase() : "";
    const count = Number.isFinite(body?.count) ? Math.max(10, Math.min(150, Math.floor(body.count))) : 80;

    if (mode === "lookalike" && !seedDomain) {
      return NextResponse.json({ error: "seedDomain is required for look-a-like mode" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();

    // Style examples: recent owned domains in the SELECTED TLDs, from the
    // deliverability inventory. For look-a-like mode we also seed with the
    // seed domain itself.
    const orFilter = selectedTlds.map((t) => `domain.ilike.%${t}`).join(",");
    const { data: ownedRows } = await supabase
      .from("deliverability_domains")
      .select("domain")
      .or(orFilter)
      .order("domain_created_at", { ascending: false, nullsFirst: false })
      .limit(200);
    const owned = (ownedRows || [])
      .map((r) => (r.domain as string)?.toLowerCase())
      .filter((d): d is string => !!d && selectedTlds.some((t) => d.endsWith(t)));

    const examples: string[] = [];
    if (mode === "lookalike" && seedDomain) examples.push(seedDomain);
    const pool = [...owned];
    while (examples.length < EXAMPLE_SAMPLE_SIZE && pool.length > 0) {
      const idx = Math.floor(Math.random() * pool.length);
      examples.push(pool.splice(idx, 1)[0]);
    }

    const candidates = await generateDomainCandidates({
      mode,
      tlds: selectedTlds,
      count,
      niche,
      seedDomain,
      examples,
    });
    if (candidates.length === 0) {
      return NextResponse.json({ candidates: [], skippedAlreadyChecked: 0, examplesUsed: examples.length });
    }

    // Skip domains we've already checked previously — saves Porkbun rate-limit budget.
    const { data: existing } = await supabase
      .from("porkbun_domains")
      .select("domain")
      .in("domain", candidates);
    const seen = new Set((existing || []).map((r) => r.domain as string));
    // Also skip anything already in the user's deliverability inventory.
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
