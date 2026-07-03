import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { resolveInstances } from "@/lib/bison";

/**
 * GET /api/deliverability/provider-status?instances=<csv>
 *
 * Returns the cached provider-lifecycle status for every domain in the
 * requested Bison instances, keyed by "instance:domain". Consumed by the
 * Deliverability page's Provider column + filter chip. Rows without a
 * cache entry (never checked, or missing an Inboxing/Milkbox tag) are
 * absent from the response and the FE renders them as "Unknown".
 *
 * Populated by /api/cron/provider-domain-status-check (daily 08:00 UTC).
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const instances = resolveInstances(searchParams);
    const supabase = getSupabaseAdmin();

    interface Row {
      instance: string;
      domain: string;
      provider: string;
      status: string;
      raw_status: string | null;
      failure_reason: string | null;
      checked_at: string;
    }

    const out: Record<string, {
      status: "active" | "canceled";
      raw_status: string | null;
      failure_reason: string | null;
      checked_at: string;
      provider: string;
    }> = {};

    const PAGE = 1000;
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from("provider_domain_status")
        .select("instance, domain, provider, status, raw_status, failure_reason, checked_at")
        .in("instance", instances)
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      for (const r of data as Row[]) {
        // Guard against any unexpected status strings (shouldn't happen; cron
        // only writes 'active' or 'canceled', but be defensive on read).
        const bucket = r.status === "active" ? "active" : "canceled";
        out[`${r.instance}:${r.domain}`] = {
          status: bucket,
          raw_status: r.raw_status,
          failure_reason: r.failure_reason,
          checked_at: r.checked_at,
          provider: r.provider,
        };
      }
      if (data.length < PAGE) break;
      offset += PAGE;
    }

    return NextResponse.json({ statuses: out });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
