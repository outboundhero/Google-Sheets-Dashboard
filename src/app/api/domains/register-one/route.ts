import { NextResponse } from "next/server";
import { createDomain, setAutoRenew } from "@/lib/porkbun";
import { getSupabaseAdmin } from "@/lib/supabase";

const PRICE_CAP_USD = 4;

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const domain = typeof body?.domain === "string" ? body.domain.trim().toLowerCase() : "";
    if (!domain) {
      return NextResponse.json({ error: "domain is required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const { data: row, error: readErr } = await supabase
      .from("porkbun_domains")
      .select("domain, price_usd, available, registered")
      .eq("domain", domain)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!row) {
      return NextResponse.json({ error: "Domain not in discovery table — re-check first" }, { status: 404 });
    }
    if (row.registered) {
      return NextResponse.json({ domain, registered: true, autoRenewDisabled: true, alreadyRegistered: true });
    }
    if (!row.available) {
      return NextResponse.json({ error: "Domain marked unavailable" }, { status: 400 });
    }
    const priceUsd = typeof row.price_usd === "number" ? row.price_usd : parseFloat(row.price_usd || "0");
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
      return NextResponse.json({ error: "Invalid stored price" }, { status: 400 });
    }
    if (priceUsd > PRICE_CAP_USD) {
      return NextResponse.json({ error: `Price $${priceUsd} above $${PRICE_CAP_USD} cap` }, { status: 400 });
    }

    // Step 1: register
    try {
      await createDomain(domain, priceUsd);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "createDomain failed";
      await supabase
        .from("porkbun_domains")
        .update({ last_error: msg.slice(0, 500) })
        .eq("domain", domain);
      return NextResponse.json({ domain, error: msg, step: "create" }, { status: 502 });
    }

    await supabase
      .from("porkbun_domains")
      .update({ registered: true, registered_at: new Date().toISOString(), last_error: null })
      .eq("domain", domain);

    // Step 2: turn off auto-renew
    let autoRenewDisabled = false;
    let autoRenewError: string | null = null;
    try {
      await setAutoRenew(domain, false);
      autoRenewDisabled = true;
      await supabase
        .from("porkbun_domains")
        .update({ auto_renew_disabled: true })
        .eq("domain", domain);
    } catch (err) {
      autoRenewError = err instanceof Error ? err.message : "setAutoRenew failed";
      await supabase
        .from("porkbun_domains")
        .update({ last_error: autoRenewError.slice(0, 500) })
        .eq("domain", domain);
    }

    return NextResponse.json({
      domain,
      registered: true,
      autoRenewDisabled,
      autoRenewError,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
