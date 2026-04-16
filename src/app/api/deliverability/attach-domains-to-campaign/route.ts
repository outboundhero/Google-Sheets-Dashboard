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

    // 1. Get all inbox IDs for the selected domains (paginate past 1000-row limit)
    const allInboxIds: number[] = [];
    for (let i = 0; i < domains.length; i += 20) {
      const batch = domains.slice(i, i + 20);
      let offset = 0;
      while (true) {
        const { data } = await supabase
          .from("deliverability_inboxes")
          .select("id")
          .in("domain", batch)
          .range(offset, offset + 999);
        if (!data || data.length === 0) break;
        allInboxIds.push(...data.map((d) => d.id));
        if (data.length < 1000) break;
        offset += 1000;
      }
    }

    console.log(`[ATTACH-DOMAIN] Campaign ${campaign_id}: found ${allInboxIds.length} inboxes across ${domains.length} domains`);

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

    // 4. Attach in batches of 50 with retry for invalid IDs
    let attached = 0;
    let failed = 0;
    const ATTACH_BATCH = 50;
    for (let i = 0; i < newIds.length; i += ATTACH_BATCH) {
      const batch = newIds.slice(i, i + ATTACH_BATCH);

      try {
        const res = await fetch(`${API_BASE}/campaigns/${campaign_id}/attach-sender-emails`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ sender_email_ids: batch }),
        });

        if (res.ok) {
          attached += batch.length;
        } else if (res.status === 422) {
          // Invalid IDs in batch — fall back to sub-batches of 10
          console.warn(`[ATTACH-DOMAIN] Campaign ${campaign_id} batch ${i}-${i + batch.length} got 422, retrying in sub-batches`);
          for (let j = 0; j < batch.length; j += 10) {
            const sub = batch.slice(j, j + 10);
            try {
              const subRes = await fetch(`${API_BASE}/campaigns/${campaign_id}/attach-sender-emails`, {
                method: "POST",
                headers: { ...headers, "Content-Type": "application/json" },
                body: JSON.stringify({ sender_email_ids: sub }),
              });
              if (subRes.ok) {
                attached += sub.length;
              } else {
                // Try one by one to skip individual bad IDs
                for (const id of sub) {
                  try {
                    const singleRes = await fetch(`${API_BASE}/campaigns/${campaign_id}/attach-sender-emails`, {
                      method: "POST",
                      headers: { ...headers, "Content-Type": "application/json" },
                      body: JSON.stringify({ sender_email_ids: [id] }),
                    });
                    if (singleRes.ok) attached++;
                    else { failed++; console.warn(`[ATTACH-DOMAIN] Invalid inbox ID ${id}, skipping`); }
                  } catch { failed++; }
                }
              }
            } catch { failed += sub.length; }
            await delay(200);
          }
        } else {
          const errText = await res.text().catch(() => "");
          console.error(`[ATTACH-DOMAIN] Campaign ${campaign_id} batch ${i}-${i + batch.length}: ${res.status} ${errText.slice(0, 200)}`);
          failed += batch.length;
        }
      } catch (e) {
        console.error(`[ATTACH-DOMAIN] Campaign ${campaign_id} batch ${i}-${i + batch.length} network error:`, e);
        failed += batch.length;
      }

      if (i + ATTACH_BATCH < newIds.length) await delay(300);
    }

    return NextResponse.json({
      total_matched: allInboxIds.length,
      already_attached: alreadyCount,
      newly_attached: attached,
      failed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
