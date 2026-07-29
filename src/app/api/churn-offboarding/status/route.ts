import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { ALL_INSTANCE_SLUGS } from "@/lib/bison-instances";

export const maxDuration = 60;

// GET /api/churn-offboarding/status — per churned client, the REAL offboarding
// completeness (Spencer's Loom: "grey if done, yellow if action needed" — and
// it must reflect reality, since the recorded decision kept lying while tags
// came back). Returns { [CLIENTABBR]: { activeCampaigns, taggedDomains,
// decision, done } }. `done` = no active campaigns AND no tagged domains left.
const ACTIVE_CAMPAIGN_STATUSES = new Set(["active", "launching", "queued", "launch processing", "paused", "draft"]);

export async function GET() {
  try {
    const supabase = getSupabaseAdmin();

    // recorded decisions
    const decisionByTag = new Map<string, string>();
    const { data: actions } = await supabase
      .from("client_offboarding_actions")
      .select("client_abbr,status");
    for (const a of actions || []) decisionByTag.set(String(a.client_abbr).trim().toUpperCase(), a.status as string);

    // active campaigns per client tag
    const activeByTag = new Map<string, number>();
    const { data: camps } = await supabase
      .from("campaigns")
      .select("client_tag,status")
      .in("instance", ALL_INSTANCE_SLUGS);
    for (const c of camps || []) {
      if (!c.client_tag) continue;
      if (!ACTIVE_CAMPAIGN_STATUSES.has((c.status || "").trim().toLowerCase())) continue;
      const t = String(c.client_tag).trim().toUpperCase();
      activeByTag.set(t, (activeByTag.get(t) || 0) + 1);
    }

    // domains still carrying each tag (a churned client should have 0)
    const taggedByTag = new Map<string, number>();
    let off = 0;
    while (true) {
      const { data, error } = await supabase
        .from("deliverability_domains")
        .select("tags")
        .in("instance", ALL_INSTANCE_SLUGS)
        .range(off, off + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      for (const d of data) {
        for (const t of (d.tags as string[] | null) || []) {
          const bare = String(t).split(":")[0].trim().toUpperCase();
          if (bare) taggedByTag.set(bare, (taggedByTag.get(bare) || 0) + 1);
        }
      }
      if (data.length < 1000) break;
      off += 1000;
    }

    const tags = new Set<string>([...decisionByTag.keys(), ...activeByTag.keys(), ...taggedByTag.keys()]);
    const status: Record<string, { activeCampaigns: number; taggedDomains: number; decision: string | null; done: boolean }> = {};
    for (const t of tags) {
      const activeCampaigns = activeByTag.get(t) || 0;
      const taggedDomains = taggedByTag.get(t) || 0;
      status[t] = {
        activeCampaigns,
        taggedDomains,
        decision: decisionByTag.get(t) || null,
        done: activeCampaigns === 0 && taggedDomains === 0,
      };
    }
    return NextResponse.json({ status });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
