// TEMPORARY diagnostic endpoint — verifies that the deployed pipeline (sheet
// read → tracker rows → churnedTags set → campaigns match) returns the
// expected counts. Bearer-authed, exempt from middleware. Delete once the
// "Churned clients" pill discrepancy is resolved.
import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getClientTrackerData } from "@/lib/google-sheets";

const EXTERNAL_API_TOKEN = process.env.EXTERNAL_API_TOKEN || "outboundhero2024";
const GROUP_OF: Record<string, 1 | 2> = {
  outboundhero: 1, cleaningoutbound: 1, facilityreach: 2, outboundclean: 2,
};

export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  if (!auth || auth !== `Bearer ${EXTERNAL_API_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 1) tracker rows — exact same code path the Campaigns page uses.
  const tracker = await getClientTrackerData();
  const now = new Date();
  const churnedTags = new Set<string>();
  const sampleChurned: { abbr: string; churn: string }[] = [];
  for (const c of tracker) {
    if (!c.churnDate) continue;
    if ((c.status || "").trim().toLowerCase() !== "churned") continue;
    const d = new Date(c.churnDate);
    if (isNaN(d.getTime()) || d > now) continue;
    const tag = (c.clientAbbr || "").trim().toUpperCase();
    if (!tag) continue;
    churnedTags.add(tag);
    if (sampleChurned.length < 25) sampleChurned.push({ abbr: tag, churn: c.churnDate });
  }

  // 2) campaigns table — paginated full scan.
  const supabase = getSupabaseAdmin();
  const stats = { group1: { total: 0, churned: 0 }, group2: { total: 0, churned: 0 } };
  const churnedHits: Record<string, number> = {};
  let off = 0;
  while (true) {
    const { data, error } = await supabase
      .from("campaigns")
      .select("instance,status,client_tag")
      .range(off, off + 999);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;
    for (const r of data) {
      const g = GROUP_OF[r.instance];
      if (!g) continue;
      const tag = (r.client_tag || "").trim().toUpperCase();
      const isChurned = !!tag && churnedTags.has(tag);
      if (g === 1) { stats.group1.total++; if (isChurned) stats.group1.churned++; }
      else { stats.group2.total++; if (isChurned) stats.group2.churned++; }
      if (isChurned) churnedHits[tag] = (churnedHits[tag] || 0) + 1;
    }
    if (data.length < 1000) break;
    off += 1000;
  }

  return NextResponse.json({
    trackerRowCount: tracker.length,
    churnedTagsSize: churnedTags.size,
    sampleChurned,
    stats,
    topChurnedHits: Object.entries(churnedHits)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([tag, n]) => ({ tag, campaigns: n })),
    serverNow: now.toISOString(),
  });
}
