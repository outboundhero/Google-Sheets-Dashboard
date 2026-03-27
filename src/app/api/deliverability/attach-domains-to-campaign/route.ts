import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

const API_BASE = "https://app.outboundhero.co/api";
const API_KEY = process.env.OUTBOUNDHERO_API_KEY!;
const headers = { Authorization: `Bearer ${API_KEY}` };
const BATCH_SIZE = 100;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(request: Request) {
  try {
    const { campaign_id, domains } = (await request.json()) as {
      campaign_id: number;
      domains: string[];
    };

    if (!campaign_id || !domains?.length) {
      return NextResponse.json({ error: "campaign_id and domains required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();

    // 1. Get all inbox IDs for the selected domains
    const allInboxIds: number[] = [];
    for (let i = 0; i < domains.length; i += 50) {
      const batch = domains.slice(i, i + 50);
      const { data } = await supabase
        .from("deliverability_inboxes")
        .select("id")
        .in("domain", batch);
      if (data) allInboxIds.push(...data.map((d) => d.id));
    }

    if (allInboxIds.length === 0) {
      return NextResponse.json({ total_matched: 0, already_attached: 0, newly_attached: 0 });
    }

    // 2. Get already-attached sender emails for this campaign
    const alreadyAttached = new Set<number>();
    let page = 1;
    while (true) {
      const res = await fetch(
        `${API_BASE}/campaigns/${campaign_id}/sender-emails?page=${page}&per_page=100`,
        { headers, cache: "no-store" }
      );
      if (!res.ok) break;
      const json = await res.json();
      const data = json.data || [];
      for (const item of data) alreadyAttached.add(item.id);
      const lastPage = json.meta?.last_page || 1;
      if (page >= lastPage) break;
      page++;
    }

    // 3. Filter out already-attached
    const newIds = allInboxIds.filter((id) => !alreadyAttached.has(id));
    const alreadyCount = allInboxIds.length - newIds.length;

    // 4. Attach in batches of 100
    let attached = 0;
    for (let i = 0; i < newIds.length; i += BATCH_SIZE) {
      const batch = newIds.slice(i, i + BATCH_SIZE);
      const res = await fetch(`${API_BASE}/campaigns/${campaign_id}/attach-sender-emails`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ sender_email_ids: batch }),
      });
      if (res.ok) {
        attached += batch.length;
      }
      if (i + BATCH_SIZE < newIds.length) await delay(150);
    }

    return NextResponse.json({
      total_matched: allInboxIds.length,
      already_attached: alreadyCount,
      newly_attached: attached,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
