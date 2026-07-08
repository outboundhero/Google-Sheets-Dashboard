import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { resolveInstances } from "@/lib/bison";

// Explicit column list — everything the deliverability table's DomainRow
// consumes, nothing more. daily_limit_total / warmup_limit_total are STORED
// columns maintained by rebuild_domain_stats(); this route used to derive
// them per-request by dragging the entire deliverability_inboxes table
// (~183K rows, ~200 round-trips) into Node on every page load, which was the
// dominant cost of opening the deliverability dashboard.
const COLUMNS = [
  "instance",
  "domain",
  "inbox_count",
  "domain_created_at",
  "warmup_status",
  "tags",
  "total_sent",
  "total_replied",
  "total_bounced",
  "outlook_count",
  "google_count",
  "daily_limit_total",
  "warmup_limit_total",
  "redirect_url",
  "redirect_checked_at",
  "blacklisted",
  "blacklist_checked_at",
  "spamhaus_dbl",
  "spamhaus_checked_at",
].join(", ");

export async function GET(request: Request) {
  try {
    const supabase = getSupabaseAdmin();
    const { searchParams } = new URL(request.url);
    const tagsParam = searchParams.get("tags");
    const instances = resolveInstances(searchParams);

    // Get total count first, then fetch all pages in parallel
    const PAGE = 1000;
    const tagNames = tagsParam
      ? tagsParam.split(",").map((t) => t.trim()).filter(Boolean)
      : [];

    const buildQuery = () => {
      let q = supabase
        .from("deliverability_domains")
        .select(COLUMNS, { count: "exact" })
        .in("instance", instances)
        .order("domain_created_at", { ascending: false, nullsFirst: false });
      if (tagNames.length > 0) q = q.overlaps("tags", tagNames);
      return q;
    };

    // First page also returns the total count
    const firstRes = await buildQuery().range(0, PAGE - 1);
    if (firstRes.error) throw firstRes.error;
    const total = firstRes.count || firstRes.data?.length || 0;
    const allDomains: Record<string, unknown>[] = [
      ...((firstRes.data || []) as unknown as Record<string, unknown>[]),
    ];

    // Fetch remaining pages in parallel
    if (total > PAGE) {
      const remainingPages = Math.ceil(total / PAGE) - 1;
      const pagePromises = [];
      for (let i = 1; i <= remainingPages; i++) {
        pagePromises.push(buildQuery().range(i * PAGE, (i + 1) * PAGE - 1));
      }
      const pageResults = await Promise.all(pagePromises);
      for (const res of pageResults) {
        if (res.data) allDomains.push(...(res.data as unknown as Record<string, unknown>[]));
      }
    }

    return NextResponse.json(allDomains);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
