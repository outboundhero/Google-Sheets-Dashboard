import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { resolveInstances } from "@/lib/bison";
import { pstDateString } from "@/lib/date-utils";

// Trailing 10d/15d reply & bounce rates per domain, computed by diffing the
// daily deliverability_domain_snapshots (see trailing_domain_rates RPC).
// Returns rates plus how many days of snapshot history exist (warm-up progress).
export async function GET(request: Request) {
  try {
    const supabase = getSupabaseAdmin();
    const { searchParams } = new URL(request.url);
    const instances = resolveInstances(searchParams);
    const today = pstDateString(new Date());

    // PostgREST caps RPC results at db-max-rows (default 1000), so paginate —
    // outboundhero alone has ~4k domains and would otherwise be truncated.
    const PAGE = 1000;
    const rates: unknown[] = [];
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .rpc("trailing_domain_rates", { p_instances: instances, p_today: today })
        .order("instance", { ascending: true })
        .order("domain", { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      rates.push(...data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }

    // Earliest snapshot we hold for these instances → warm-up day count.
    const { data: minRow } = await supabase
      .from("deliverability_domain_snapshots")
      .select("snapshot_date")
      .in("instance", instances)
      .order("snapshot_date", { ascending: true })
      .limit(1);
    const earliest = minRow?.[0]?.snapshot_date as string | undefined;
    const daysCollected = earliest
      ? Math.round((new Date(today).getTime() - new Date(earliest).getTime()) / 86_400_000) + 1
      : 0;

    return NextResponse.json({ today, daysCollected, rates });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
