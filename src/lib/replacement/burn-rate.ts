// How many domains each instance burns per week — the buy list's cover for what
// will burn while newly bought stock is still warming (Nick 2026-10-19: the
// list said ~117 for B2B #2 and he bought 200 to be safe). Every burnt domain
// lands once in replacement_cancellations (one row per instance+domain,
// created_at = the day it was flagged, reserve sweeps included), so a row
// count over a trailing window is the burn rate. 'aborted' rows are review
// rejections — the domain stayed — so they don't count.
import { getSupabaseAdmin } from "@/lib/supabase";
import { ALL_INSTANCE_SLUGS } from "@/lib/bison-instances";

export const BURN_WINDOW_WEEKS = 4;

/** instance → average burnt domains per week over the last BURN_WINDOW_WEEKS.
 *  Returns null on a read failure so the caller can say the cover is missing
 *  instead of silently treating it as zero burn. */
export async function getWeeklyBurn(): Promise<Record<string, number> | null> {
  const supabase = getSupabaseAdmin();
  const since = new Date(Date.now() - BURN_WINDOW_WEEKS * 7 * 86_400_000).toISOString();
  try {
    const out: Record<string, number> = {};
    await Promise.all(ALL_INSTANCE_SLUGS.map(async (slug) => {
      const { count, error } = await supabase
        .from("replacement_cancellations")
        .select("domain", { count: "exact", head: true })
        .eq("instance", slug)
        .neq("status", "aborted")
        .gte("created_at", since);
      if (error) throw new Error(error.message);
      out[slug] = (count ?? 0) / BURN_WINDOW_WEEKS;
    }));
    return out;
  } catch (e) {
    console.error("[burn-rate] replacement_cancellations read failed:", e);
    return null;
  }
}
