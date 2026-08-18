import { NextResponse } from "next/server";
import { getCancellations } from "@/lib/replacement/store";
import { getSupabaseAdmin } from "@/lib/supabase";

// GET /api/replacement/cancellations?status=pending — the vendor-delete queue.
// Read-only; admin-only via middleware. Deletes nothing.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const statuses = status ? status.split(",") : ["pending"];
    const cancellations = await getCancellations(statuses);

    // Nick 2026-08-18: "I would like to see the sending data before I go and
    // delete the domains." Attach each row's lifetime stats so the review
    // card can show them; a domain missing from deliverability_domains just
    // comes back without stats rather than blocking the queue.
    if (cancellations.length > 0) {
      const supabase = getSupabaseAdmin();
      const domains = [...new Set(cancellations.map((c) => c.domain))];
      const statsByKey = new Map<string, { sent: number; replied: number; bounced: number }>();
      for (let i = 0; i < domains.length; i += 300) {
        const { data } = await supabase
          .from("deliverability_domains")
          .select("instance, domain, total_sent, total_replied, total_bounced")
          .in("domain", domains.slice(i, i + 300));
        for (const d of data || []) {
          statsByKey.set(`${d.instance}:${d.domain}`, {
            sent: d.total_sent ?? 0,
            replied: d.total_replied ?? 0,
            bounced: d.total_bounced ?? 0,
          });
        }
      }
      for (const c of cancellations as (typeof cancellations[number] & {
        stats?: { sent: number; replied: number; bounced: number };
      })[]) {
        c.stats = statsByKey.get(`${c.instance}:${c.domain}`);
      }
    }

    return NextResponse.json({ cancellations });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
