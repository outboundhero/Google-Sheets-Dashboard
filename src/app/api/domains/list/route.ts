import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export async function GET() {
  try {
    const supabase = getSupabaseAdmin();
    // No price cap — every available, unregistered discovery is listed with its
    // real Porkbun price so the user can decide.
    const { data, error } = await supabase
      .from("porkbun_domains")
      .select("domain, price_usd, regular_price_usd, niche, discovered_at, registered, registered_at, auto_renew_disabled, appended_to_sheet, surbl_listed, surbl_checked_at, spamhaus_listed, spamhaus_checked_at")
      .eq("registered", false)
      .eq("available", true)
      .order("price_usd", { ascending: true })
      .order("discovered_at", { ascending: false });

    if (error) throw new Error(error.message);

    return NextResponse.json({ domains: data || [] });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
