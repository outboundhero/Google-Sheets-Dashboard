import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

const PRICE_CAP_USD = 4;

export async function GET() {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("porkbun_domains")
      .select("domain, price_usd, regular_price_usd, niche, discovered_at, registered, registered_at, auto_renew_disabled, appended_to_sheet")
      .eq("registered", false)
      .eq("available", true)
      .lte("price_usd", PRICE_CAP_USD)
      .order("price_usd", { ascending: true })
      .order("discovered_at", { ascending: false });

    if (error) throw new Error(error.message);

    return NextResponse.json({ domains: data || [] });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
