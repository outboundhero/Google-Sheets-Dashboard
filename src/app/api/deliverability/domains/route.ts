import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export async function GET(request: Request) {
  try {
    const supabase = getSupabaseAdmin();
    const { searchParams } = new URL(request.url);
    const tagsParam = searchParams.get("tags");

    // Paginate to get ALL domains (Supabase caps at 1000 per query)
    const allDomains: Record<string, unknown>[] = [];
    const PAGE = 1000;
    let offset = 0;

    while (true) {
      let query = supabase
        .from("deliverability_domains")
        .select("*")
        .order("domain_created_at", { ascending: false, nullsFirst: false })
        .range(offset, offset + PAGE - 1);

      if (tagsParam) {
        const tagNames = tagsParam.split(",").map((t) => t.trim()).filter(Boolean);
        if (tagNames.length > 0) {
          query = query.overlaps("tags", tagNames);
        }
      }

      const { data, error } = await query;
      if (error) throw error;
      if (!data || data.length === 0) break;
      allDomains.push(...data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }

    // Aggregate daily_limit and warmup_daily_limit from inboxes per domain
    const domainNames = allDomains.map((d) => d.domain as string);
    const limitMap = new Map<string, { daily_limit: number; warmup_limit: number }>();

    if (domainNames.length > 0) {
      // Query one inbox per domain using DISTINCT ON via raw SQL for efficiency
      // Fallback: paginate through all inboxes
      for (let i = 0; i < domainNames.length; i += 200) {
        const batch = domainNames.slice(i, i + 200);
        let offset = 0;
        const seen = new Set<string>();
        while (true) {
          const { data: inboxData } = await supabase
            .from("deliverability_inboxes")
            .select("domain, daily_limit, warmup_daily_limit")
            .in("domain", batch)
            .range(offset, offset + 999);

          if (!inboxData || inboxData.length === 0) break;
          for (const inbox of inboxData) {
            if (!seen.has(inbox.domain)) {
              seen.add(inbox.domain);
              limitMap.set(inbox.domain, {
                daily_limit: inbox.daily_limit || 0,
                warmup_limit: inbox.warmup_daily_limit || 0,
              });
            }
          }
          if (inboxData.length < 1000) break;
          offset += 1000;
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
