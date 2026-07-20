import { NextResponse } from "next/server";
import { checkDomain } from "@/lib/porkbun";
import { getSupabaseAdmin } from "@/lib/supabase";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const domain = typeof body?.domain === "string" ? body.domain.trim().toLowerCase() : "";
    const niche = typeof body?.niche === "string" && body.niche.trim() ? body.niche.trim() : "commercial cleaning";
    if (!domain) {
      return NextResponse.json({ error: "domain is required" }, { status: 400 });
    }

    // Live, exact price from Porkbun — never an estimate. No price cap: any
    // available domain qualifies; the real price is surfaced for the user to
    // decide + is used verbatim at purchase time.
    const result = await checkDomain(domain);
    const qualifies = result.avail && Number.isFinite(result.price);

    const supabase = getSupabaseAdmin();
    await supabase.from("porkbun_domains").upsert(
      {
        domain,
        niche,
        available: result.avail,
        price_usd: Number.isFinite(result.price) ? result.price : null,
        regular_price_usd: Number.isFinite(result.regularPrice) ? result.regularPrice : null,
      },
      { onConflict: "domain" }
    );

    return NextResponse.json({
      domain,
      available: result.avail,
      price: result.price,
      regularPrice: result.regularPrice,
      qualifies,
      ttlRemaining: result.ttlRemaining,
      rateLimitNote: result.rateLimitNote,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
