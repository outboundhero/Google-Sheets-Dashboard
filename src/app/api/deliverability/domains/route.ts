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
    const limitMap = new Map<string, { daily_limit_total: number; warmup_limit_total: number }>();

    if (domainNames.length > 0) {
      // Query in batches of 500 domains
      for (let i = 0; i < domainNames.length; i += 500) {
        const batch = domainNames.slice(i, i + 500);
        const { data: inboxData } = await supabase
          .from("deliverability_inboxes")
          .select("domain, daily_limit, warmup_daily_limit")
          .in("domain", batch);

        if (inboxData) {
          for (const inbox of inboxData) {
            const existing = limitMap.get(inbox.domain) || { daily_limit_total: 0, warmup_limit_total: 0 };
            existing.daily_limit_total += inbox.daily_limit || 0;
            existing.warmup_limit_total += inbox.warmup_daily_limit || 0;
            limitMap.set(inbox.domain, existing);
          }
        }
      }
    }

    // Merge limit data into domains
    const result = allDomains.map((d) => {
      const limits = limitMap.get(d.domain as string);
      return {
        ...d,
        daily_limit_total: limits?.daily_limit_total || 0,
        warmup_limit_total: limits?.warmup_limit_total || 0,
      };
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
