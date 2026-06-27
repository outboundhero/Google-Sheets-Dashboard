import { NextResponse } from "next/server";
import { readClientTracker } from "@/lib/replacement/redirect-audit";
import { getKnownClientTags } from "@/lib/replacement/cross-tag-audit";
import { getSupabaseAdmin } from "@/lib/supabase";
import { ALL_INSTANCE_SLUGS } from "@/lib/bison-instances";

export const maxDuration = 60;

// GET /api/replacement/tag-alignment — re-reads the Client Tracker sheet live
// and checks client-tag alignment vs the system:
//   untracked = client tags that have domains assigned but aren't in the tracker
//               (tracker is missing those clients).
//   orphan    = client tags listed in the tracker that have no assigned domains
//               (stale tracker entries / churned or not-yet-set-up clients).
// Admin-only via middleware.
export async function GET() {
  try {
    const { allTags: trackerTagsRaw } = await readClientTracker();
    const knownTags = await getKnownClientTags(); // real client tags = campaign name prefixes

    // Client tags actually applied to domains in the system.
    const supabase = getSupabaseAdmin();
    const assigned = new Set<string>();
    let off = 0;
    while (true) {
      const { data } = await supabase.from("deliverability_domains").select("tags").in("instance", ALL_INSTANCE_SLUGS).range(off, off + 999);
      if (!data || data.length === 0) break;
      for (const r of data) {
        let tags: unknown = r.tags;
        if (typeof tags === "string") { try { tags = JSON.parse(tags); } catch { tags = []; } }
        for (const t of (tags as unknown[]) || []) {
          const n = String(t && typeof t === "object" ? (t as { name?: string }).name : t).trim();
          if (n && knownTags.has(n)) assigned.add(n.toUpperCase());
        }
      }
      if (data.length < 1000) break;
      off += 1000;
    }

    const tracker = new Set([...trackerTagsRaw].map((t) => t.toUpperCase()));
    const untracked = [...assigned].filter((t) => !tracker.has(t)).sort();
    const orphan = [...tracker].filter((t) => !assigned.has(t)).sort();

    return NextResponse.json({
      trackerCount: tracker.size,
      assignedCount: assigned.size,
      untracked,
      orphan,
      checkedAt: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
