import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch, resolveInstance } from "@/lib/bison";

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

// POST — search Bison for inboxes matching given domains and import them (scoped to instance)
export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const instance = resolveInstance(searchParams.get("instance"));
    const { domains } = (await request.json()) as { domains: string[] };
    if (!domains?.length) {
      return NextResponse.json({ error: "domains required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const allInboxes: SenderEmail[] = [];

    // Search Bison for each domain — try multiple search terms
    for (const domain of domains) {
      const found = new Map<number, SenderEmail>();

      // Search by full domain and by domain parts
      const searchTerms = [domain];
      const parts = domain.split(".");
      if (parts.length >= 2) searchTerms.push(parts[0]); // e.g., "getbtsb" from "getbtsb.info"

      for (const term of searchTerms) {
        let page = 1;
        while (true) {
          const res = await bisonFetch(
            instance,
            `/sender-emails?search=${encodeURIComponent(term)}&page=${page}&per_page=15`,
          );
          if (!res.ok) break;
          const json = await res.json();
          const payload = Array.isArray(json) ? json[0] : json;
          const data: SenderEmail[] = payload.data || [];
          for (const inbox of data) {
            if (inbox.email.split("@")[1]?.toLowerCase() === domain.toLowerCase()) {
              found.set(inbox.id, inbox);
            }
          }
          const lastPage = payload.meta?.last_page || 1;
          if (page >= lastPage || page >= 20) break; // cap at 20 pages per search
          page++;
        }
      }

      console.log(`[IMPORT:${instance}] ${domain}: found ${found.size} inboxes`);
      allInboxes.push(...found.values());
    }

    if (allInboxes.length === 0) {
      return NextResponse.json({ imported: 0, message: "No inboxes found on Bison for these domains", instance });
    }

    // Ensure (instance, domain) rows exist
    const domainSet = new Map<string, string>();
    for (const inbox of allInboxes) {
      const d = inbox.email.split("@")[1]?.toLowerCase();
      if (!d) continue;
      if (!domainSet.has(d) || inbox.created_at < domainSet.get(d)!) {
        domainSet.set(d, inbox.created_at);
      }
    }

    const domainRows = Array.from(domainSet.entries()).map(([domain, created_at]) => ({
      instance,
      domain,
      domain_created_at: created_at,
      warmup_status: "open",
      synced_at: new Date().toISOString(),
    }));

    await supabase
      .from("deliverability_domains")
      .upsert(domainRows, { onConflict: "instance,domain", ignoreDuplicates: true });

    // Upsert inboxes
    const inboxRows = allInboxes.map((inbox) => ({
      id: inbox.id,
      instance,
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
        .upsert(inboxRows.slice(i, i + 500), { onConflict: "instance,id", ignoreDuplicates: false });
    }

    // Rebuild stats via SQL (works for all instances at once)
    await supabase.rpc("rebuild_domain_stats");

    return NextResponse.json({
      imported: allInboxes.length,
      domains: domainSet.size,
      instance,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
