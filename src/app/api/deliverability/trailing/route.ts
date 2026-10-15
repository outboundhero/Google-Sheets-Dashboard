import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { resolveInstances } from "@/lib/bison";
import { pstDateString } from "@/lib/date-utils";
import { loadTrailingRateRows } from "@/lib/replacement/trailing-rates";

// Trailing 10d/15d reply & bounce rates per domain, computed by diffing the
// daily deliverability_domain_snapshots (see trailing_domain_rates RPC).
// Returns rates plus how many days of snapshot history exist (warm-up progress).
export async function GET(request: Request) {
  try {
    const supabase = getSupabaseAdmin();
    const { searchParams } = new URL(request.url);
    const instances = resolveInstances(searchParams);
    const today = pstDateString(new Date());

    // One JSON-aggregated call (no PostgREST 1000-row cap, no per-page re-scan);
    // see trailing-rates.ts for the fast function and its fallback.
    const rates = await loadTrailingRateRows(instances, today);

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
