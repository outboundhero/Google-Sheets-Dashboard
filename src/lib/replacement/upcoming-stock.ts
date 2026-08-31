// How many domains an upcoming client ALREADY holds per instance — shared by
// the buy list and the purchase plan so the two can't disagree (the redirect
// lesson). Five of the seven Sep-1 launches already carried 20 tagged domains
// each (pre-provisioned) with no campaigns yet, so they were invisible to the
// active math and the upcoming math charged them a full cap again — telling
// Spencer to re-buy stock he already owns (2026-09-01 dry-run catch).
import { getSupabaseAdmin } from "@/lib/supabase";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

/** `${TAG}:${instance}` → tagged-domain count. Best-effort: a read failure
 *  returns what it has — callers treat missing as 0 (full-cap need, the
 *  conservative over-buy direction, never an under-buy of a burnt count). */
export async function getTaggedDomainCounts(
  tags: string[],
  instances: readonly BisonInstanceSlug[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const supabase = getSupabaseAdmin();
  for (const tag of [...new Set(tags)]) {
    try {
      const { data } = await supabase
        .from("deliverability_domains")
        .select("instance")
        .contains("tags", [tag])
        .in("instance", instances as string[]);
      for (const r of (data || []) as { instance: string }[]) {
        const k = `${tag}:${r.instance}`;
        out.set(k, (out.get(k) || 0) + 1);
      }
    } catch { /* missing counts read as 0 → full-cap need */ }
  }
  return out;
}
