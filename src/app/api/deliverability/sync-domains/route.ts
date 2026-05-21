import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch, resolveInstance } from "@/lib/bison";

export const maxDuration = 120;

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
  warmup_score?: number;
  warmup_daily_limit?: number;
  warmup_emails_sent?: number;
  warmup_replies_received?: number;
  warmup_emails_saved_from_spam?: number;
  warmup_bounces_received_count?: number;
  created_at: string;
  updated_at: string;
}

/**
 * POST /api/deliverability/sync-domains?instance=<slug>
 * Body: { domains: string[] }
 *
 * Syncs only the given domains by searching the Bison API for each.
 * Designed to be called in parallel streams from the frontend.
 */
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

    // Fetch inboxes for each domain via search API
    for (const domain of domains) {
      const found = new Map<number, SenderEmail>();
      let page = 1;

      while (true) {
        try {
          const res = await bisonFetch(
            instance,
            `/sender-emails?search=${encodeURIComponent(domain)}&page=${page}&per_page=15`,
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
          if (page >= lastPage) break;
          page++;
        } catch {
          break;
        }
      }

      allInboxes.push(...found.values());
    }

    if (allInboxes.length === 0) {
      return NextResponse.json({ synced: 0, domains: 0, instance });
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

    // Upsert inboxes with all fields including warmup data
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
      warmup_score: inbox.warmup_score ?? null,
      warmup_daily_limit: inbox.warmup_daily_limit ?? null,
      warmup_emails_sent: inbox.warmup_emails_sent ?? null,
      warmup_replies_received: inbox.warmup_replies_received ?? null,
      warmup_emails_saved_from_spam: inbox.warmup_emails_saved_from_spam ?? null,
      warmup_bounces_received_count: inbox.warmup_bounces_received_count ?? null,
      created_at: inbox.created_at,
      updated_at: inbox.updated_at,
      synced_at: new Date().toISOString(),
    })).filter((r) => r.domain);

    for (let i = 0; i < inboxRows.length; i += 500) {
      await supabase
        .from("deliverability_inboxes")
        .upsert(inboxRows.slice(i, i + 500), { onConflict: "instance,id", ignoreDuplicates: false });
    }

    return NextResponse.json({
      synced: allInboxes.length,
      domains: domainSet.size,
      instance,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
