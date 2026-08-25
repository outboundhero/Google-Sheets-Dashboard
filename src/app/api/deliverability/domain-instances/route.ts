import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { ALL_INSTANCE_SLUGS } from "@/lib/bison-instances";

/**
 * GET /api/deliverability/domain-instances
 *
 * Which Bison instance(s) each domain exists in, across ALL 4 instances —
 * deliberately NOT scoped by the sidebar switcher, since the whole point of
 * the Instances column is to reveal cross-instance presence the current
 * view can't see. Returns { map: { [domain]: slug[] } }.
 */
export async function GET() {
  try {
    const supabase = getSupabaseAdmin();
    const map: Record<string, string[]> = {};
    // Per-instance created date (when the domain was added to that Bison
    // instance) so the Instances column can show it — especially for
    // multi-instance domains where each copy has its own created date.
    const created: Record<string, Record<string, string | null>> = {};
    // Per-instance inbox count (Spencer 2026-08-25: overlapping-instance
    // domains must show how many inboxes sit on EACH side, not one number).
    const inboxes: Record<string, Record<string, number>> = {};
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from("deliverability_domains")
        .select("instance, domain, domain_created_at, inbox_count")
        .in("instance", ALL_INSTANCE_SLUGS)
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      for (const r of data as { instance: string; domain: string; domain_created_at: string | null; inbox_count: number | null }[]) {
        (map[r.domain] ||= []).push(r.instance);
        (created[r.domain] ||= {})[r.instance] = r.domain_created_at ?? null;
        (inboxes[r.domain] ||= {})[r.instance] = r.inbox_count ?? 0;
      }
      if (data.length < PAGE) break;
      offset += PAGE;
    }
    return NextResponse.json({ map, created, inboxes });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
