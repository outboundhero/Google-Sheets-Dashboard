import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

const API_BASE = "https://app.outboundhero.co/api";
const API_KEY = process.env.OUTBOUNDHERO_API_KEY!;
const headers = { Authorization: `Bearer ${API_KEY}` };

interface SenderEmail {
  id: number;
  name: string;
  email: string;
  daily_limit: number;
  type: string;
  status: string;
  warmup_enabled: boolean;
  tags: { id: number; name: string }[];
  emails_sent_count: number;
  total_replied_count: number;
  total_opened_count: number;
  bounced_count: number;
  created_at: string;
  updated_at: string;
}

// POST — search EmailBison for inboxes matching given domains and import them
export async function POST(request: Request) {
  try {
    const { domains } = (await request.json()) as { domains: string[] };
    if (!domains?.length) {
      return NextResponse.json({ error: "domains required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const allInboxes: SenderEmail[] = [];

    // Search EmailBison for each domain
    for (const domain of domains) {
      let page = 1;
      while (true) {
        const res = await fetch(
          `${API_BASE}/sender-emails?search=${encodeURIComponent(domain)}&page=${page}&per_page=15`,
          { headers, cache: "no-store" }
        );
        if (!res.ok) break;
        const json = await res.json();
        const payload = Array.isArray(json) ? json[0] : json;
        const data: SenderEmail[] = payload.data || [];
        // Only keep inboxes that actually match this domain
        const matching = data.filter((i) => i.email.split("@")[1]?.toLowerCase() === domain.toLowerCase());
        allInboxes.push(...matching);
        const lastPage = payload.meta?.last_page || 1;
        if (page >= lastPage) break;
        page++;
      }
    }

    if (allInboxes.length === 0) {
      return NextResponse.json({ imported: 0, message: "No inboxes found on EmailBison for these domains" });
    }

    // Ensure domains exist
    const domainSet = new Map<string, string>();
    for (const inbox of allInboxes) {
      const d = inbox.email.split("@")[1]?.toLowerCase();
      if (!d) continue;
      if (!domainSet.has(d) || inbox.created_at < domainSet.get(d)!) {
        domainSet.set(d, inbox.created_at);
      }
    }

    const domainRows = Array.from(domainSet.entries()).map(([domain, created_at]) => ({
      domain,
      domain_created_at: created_at,
      warmup_status: "open",
      synced_at: new Date().toISOString(),
    }));

    await supabase
      .from("deliverability_domains")
      .upsert(domainRows, { onConflict: "domain", ignoreDuplicates: true });

    // Upsert inboxes
    const inboxRows = allInboxes.map((inbox) => ({
      id: inbox.id,
      name: inbox.name,
      email: inbox.email,
      domain: inbox.email.split("@")[1]?.toLowerCase() || "",
      status: inbox.status,
      type: inbox.type,
      daily_limit: inbox.daily_limit,
      warmup_enabled: inbox.warmup_enabled,
      tags: inbox.tags,
      emails_sent_count: inbox.emails_sent_count,
      total_replied_count: inbox.total_replied_count,
      total_opened_count: inbox.total_opened_count,
      bounced_count: inbox.bounced_count,
      created_at: inbox.created_at,
      updated_at: inbox.updated_at,
      synced_at: new Date().toISOString(),
    })).filter((r) => r.domain);

    for (let i = 0; i < inboxRows.length; i += 500) {
      await supabase
        .from("deliverability_inboxes")
        .upsert(inboxRows.slice(i, i + 500), { onConflict: "id", ignoreDuplicates: false });
    }

    // Rebuild stats for these domains via SQL
    await supabase.rpc("rebuild_domain_stats");

    return NextResponse.json({
      imported: allInboxes.length,
      domains: domainSet.size,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
