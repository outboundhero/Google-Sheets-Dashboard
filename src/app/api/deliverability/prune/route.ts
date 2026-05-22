import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { resolveInstance } from "@/lib/bison";

export const maxDuration = 60;

// Safety cap — never delete more than this share of an instance's inboxes in
// one prune. Guards against pruning off a partial/failed crawl.
const MAX_PRUNE_FRACTION = 0.45;

/**
 * POST { instance, before } — deletes inbox rows for `instance` whose synced_at
 * is older than `before` (an ISO timestamp captured just before a full crawl).
 * Any inbox still in Bison was re-stamped during the crawl, so anything older
 * than `before` is stale (removed from Bison) and safe to delete.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const instance = resolveInstance(body?.instance);
    const before = typeof body?.before === "string" ? body.before : "";
    if (!before || isNaN(new Date(before).getTime())) {
      return NextResponse.json({ error: "valid `before` ISO timestamp required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();

    const { count: totalCount } = await supabase
      .from("deliverability_inboxes")
      .select("id", { count: "exact", head: true })
      .eq("instance", instance);
    const { count: staleCount } = await supabase
      .from("deliverability_inboxes")
      .select("id", { count: "exact", head: true })
      .eq("instance", instance)
      .lt("synced_at", before);

    const total = totalCount ?? 0;
    const stale = staleCount ?? 0;

    if (stale === 0) {
      return NextResponse.json({ instance, total, stale: 0, pruned: 0, skipped: false });
    }
    if (total > 0 && stale / total > MAX_PRUNE_FRACTION) {
      return NextResponse.json({
        instance,
        total,
        stale,
        pruned: 0,
        skipped: true,
        reason: `stale ${stale}/${total} exceeds ${Math.round(MAX_PRUNE_FRACTION * 100)}% safety cap — crawl may be incomplete`,
      });
    }

    const { error: delErr, count: delCount } = await supabase
      .from("deliverability_inboxes")
      .delete({ count: "exact" })
      .eq("instance", instance)
      .lt("synced_at", before);
    if (delErr) throw new Error(delErr.message);

    // Recompute domain inbox_count + drop orphan domains on the cleaned set.
    const { error: rpcErr } = await supabase.rpc("rebuild_domain_stats");
    if (rpcErr) console.error("[prune] rebuild_domain_stats failed:", rpcErr.message);

    return NextResponse.json({
      instance,
      total,
      stale,
      pruned: delCount ?? 0,
      statsRebuilt: !rpcErr,
      skipped: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
