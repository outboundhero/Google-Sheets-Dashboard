import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

const API_BASE = "https://app.outboundhero.co/api";
const API_KEY = process.env.OUTBOUNDHERO_API_KEY!;
const headers = { Authorization: `Bearer ${API_KEY}` };

export const maxDuration = 300; // 5 min — this can be a long operation

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * POST /api/deliverability/remove-from-campaigns
 * Body: { domains: string[] }
 *
 * For each domain:
 *   1. Get all inbox IDs from Supabase
 *   2. For each inbox, get its campaigns from OutboundHero
 *   3. Group inboxes by campaign
 *   4. For each campaign: pause → remove inboxes → resume (if was active)
 */
export async function POST(request: Request) {
  try {
    const { domains } = (await request.json()) as { domains: string[] };
    if (!domains?.length) {
      return NextResponse.json({ error: "domains required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();

    // 1. Get all inbox IDs for selected domains
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

    if (allInboxIds.length === 0) {
      return NextResponse.json({ inboxes: 0, campaigns: 0, removed: 0 });
    }

    // 2. For each inbox, get its campaigns — batch 5 concurrent to avoid rate limits
    const inboxCampaigns = new Map<number, { id: number; name: string; status: string }[]>();
    for (let i = 0; i < allInboxIds.length; i += 5) {
      const batch = allInboxIds.slice(i, i + 5);
      const results = await Promise.allSettled(
        batch.map(async (inboxId) => {
          const campaigns: { id: number; name: string; status: string }[] = [];
          let page = 1;
          while (true) {
            const res = await fetch(
              `${API_BASE}/sender-emails/${inboxId}/campaigns?page=${page}&per_page=100`,
              { headers, cache: "no-store" }
            );
            if (!res.ok) break;
            const json = await res.json();
            const data = json.data || [];
            for (const c of data) {
              campaigns.push({ id: c.id, name: c.name, status: c.status });
            }
            if (page >= (json.meta?.last_page || 1)) break;
            page++;
          }
          return { inboxId, campaigns };
        })
      );
      for (const r of results) {
        if (r.status === "fulfilled") {
          inboxCampaigns.set(r.value.inboxId, r.value.campaigns);
        }
      }
      if (i + 5 < allInboxIds.length) await delay(200);
    }

    // 3. Group: campaign → inbox IDs to remove
    const campaignInboxMap = new Map<number, { name: string; status: string; inboxIds: number[] }>();
    for (const [inboxId, campaigns] of inboxCampaigns) {
      for (const c of campaigns) {
        if (!campaignInboxMap.has(c.id)) {
          campaignInboxMap.set(c.id, { name: c.name, status: c.status, inboxIds: [] });
        }
        campaignInboxMap.get(c.id)!.inboxIds.push(inboxId);
      }
    }

    // 4. For each campaign: pause (if active) → remove inboxes → resume (if was active)
    let totalRemoved = 0;
    const campaignResults: { id: number; name: string; removed: number; error?: string }[] = [];

    for (const [campaignId, info] of campaignInboxMap) {
      const wasActive = info.status.toLowerCase() === "active";

      try {
        // Pause if active
        if (wasActive) {
          await fetch(`${API_BASE}/campaigns/${campaignId}/pause`, {
            method: "PATCH",
            headers,
            cache: "no-store",
          });
          await delay(500); // Let it settle
        }

        // Remove inboxes in batches of 100
        let removed = 0;
        for (let i = 0; i < info.inboxIds.length; i += 100) {
          const batch = info.inboxIds.slice(i, i + 100);
          const res = await fetch(`${API_BASE}/campaigns/${campaignId}/remove-sender-emails`, {
            method: "DELETE",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ sender_email_ids: batch }),
          });
          if (res.ok) removed += batch.length;
          if (i + 100 < info.inboxIds.length) await delay(200);
        }

        // Resume if was active
        if (wasActive) {
          await delay(500);
          await fetch(`${API_BASE}/campaigns/${campaignId}/resume`, {
            method: "PATCH",
            headers,
            cache: "no-store",
          });
        }

        totalRemoved += removed;
        campaignResults.push({ id: campaignId, name: info.name, removed });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        campaignResults.push({ id: campaignId, name: info.name, removed: 0, error: msg });

        // Try to resume even if error occurred (safety)
        if (wasActive) {
          try {
            await fetch(`${API_BASE}/campaigns/${campaignId}/resume`, {
              method: "PATCH",
              headers,
              cache: "no-store",
            });
          } catch { /* best effort */ }
        }
      }
    }

    return NextResponse.json({
      inboxes: allInboxIds.length,
      campaigns: campaignInboxMap.size,
      removed: totalRemoved,
      details: campaignResults,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
