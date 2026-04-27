import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export async function GET(request: Request) {
  try {
    const supabase = getSupabaseAdmin();
    const { searchParams } = new URL(request.url);
    const tagsParam = searchParams.get("tags");

    // Get total count first, then fetch all pages in parallel
    const PAGE = 1000;
    const tagNames = tagsParam
      ? tagsParam.split(",").map((t) => t.trim()).filter(Boolean)
      : [];

    const buildQuery = () => {
      let q = supabase
        .from("deliverability_domains")
        .select("*", { count: "exact" })
        .order("domain_created_at", { ascending: false, nullsFirst: false });
      if (tagNames.length > 0) q = q.overlaps("tags", tagNames);
      return q;
    };

    // First page also returns the total count
    const firstRes = await buildQuery().range(0, PAGE - 1);
    if (firstRes.error) throw firstRes.error;
    const total = firstRes.count || firstRes.data?.length || 0;
    const allDomains: Record<string, unknown>[] = [...(firstRes.data || [])];

    // Fetch remaining pages in parallel
    if (total > PAGE) {
      const remainingPages = Math.ceil(total / PAGE) - 1;
      const pagePromises = [];
      for (let i = 1; i <= remainingPages; i++) {
        pagePromises.push(buildQuery().range(i * PAGE, (i + 1) * PAGE - 1));
      }
      const pageResults = await Promise.all(pagePromises);
      for (const res of pageResults) {
        if (res.data) allDomains.push(...res.data);
      }
    }

    // Aggregate daily_limit and warmup_daily_limit from inboxes per domain
    const domainNames = allDomains.map((d) => d.domain as string);
    const limitMap = new Map<string, { daily_limit: number; warmup_limit: number }>();

    if (domainNames.length > 0) {
      // Run all domain batches in parallel — within each batch, paginate sequentially
      const BATCH_SIZE = 200;
      const batches: string[][] = [];
      for (let i = 0; i < domainNames.length; i += BATCH_SIZE) {
        batches.push(domainNames.slice(i, i + BATCH_SIZE));
      }

      const batchResults = await Promise.all(
        batches.map(async (batch) => {
          const localMap = new Map<string, { daily_limit: number; warmup_limit: number }>();
          const seen = new Set<string>();
          let offset = 0;
          while (seen.size < batch.length) {
            const { data: inboxData } = await supabase
              .from("deliverability_inboxes")
              .select("domain, daily_limit, warmup_daily_limit")
              .in("domain", batch)
              .range(offset, offset + 999);

            if (!inboxData || inboxData.length === 0) break;
            for (const inbox of inboxData) {
              if (!seen.has(inbox.domain)) {
                seen.add(inbox.domain);
                localMap.set(inbox.domain, {
                  daily_limit: inbox.daily_limit || 0,
                  warmup_limit: inbox.warmup_daily_limit || 0,
                });
              }
            }
            if (inboxData.length < 1000) break;
            offset += 1000;
          }
          return localMap;
        })
      );

      for (const localMap of batchResults) {
        for (const [domain, limits] of localMap) {
          limitMap.set(domain, limits);
        }
      }
    }

    // Merge limit data into domains
    const result = allDomains.map((d) => {
      const limits = limitMap.get(d.domain as string);
      return {
        ...d,
        daily_limit_total: limits?.daily_limit || 0,
        warmup_limit_total: limits?.warmup_limit || 0,
      };
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
