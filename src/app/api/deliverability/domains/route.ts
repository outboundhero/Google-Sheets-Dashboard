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

    // No `count: "exact"` — it added ~1s to page 1 for nothing. Instead we
    // fetch pages in parallel batches (speculative) and keep going while the
    // last page in a batch is full, so we never miss rows even as the table
    // grows. For ~3,800 rows this is one parallel round (~0.5s) vs ~1.9s.
    const buildQuery = () => {
      let q = supabase
        .from("deliverability_domains")
        .select(COLUMNS)
        .in("instance", instances)
        .order("domain_created_at", { ascending: false, nullsFirst: false });
      if (tagNames.length > 0) q = q.overlaps("tags", tagNames);
      return q;
    };

    const BATCH_PAGES = 5; // 5,000-row capacity per parallel round
    const allDomains: Record<string, unknown>[] = [];
    let startPage = 0;
    while (true) {
      const results = await Promise.all(
        Array.from({ length: BATCH_PAGES }, (_, k) => {
          const p = startPage + k;
          return buildQuery().range(p * PAGE, (p + 1) * PAGE - 1);
        }),
      );
      let lastLen = 0;
      for (const res of results) {
        if (res.error) throw res.error;
        const rows = (res.data || []) as unknown as Record<string, unknown>[];
        allDomains.push(...rows);
        lastLen = rows.length;
      }
      // If the final page of the batch was full there may be more rows.
      if (lastLen < PAGE) break;
      startPage += BATCH_PAGES;
    }

    return NextResponse.json(allDomains);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
