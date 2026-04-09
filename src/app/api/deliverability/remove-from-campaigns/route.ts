import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

const API_BASE = "https://app.outboundhero.co/api";
const API_KEY = process.env.OUTBOUNDHERO_API_KEY!;
const headers = { Authorization: `Bearer ${API_KEY}` };

export const maxDuration = 300;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Get inbox IDs for given domains from Supabase */
async function getInboxIdsForDomains(domains: string[]): Promise<number[]> {
  const supabase = getSupabaseAdmin();
  const ids: number[] = [];
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
      ids.push(...data.map((d) => d.id));
      if (data.length < 1000) break;
      offset += 1000;
    }
  }
  return ids;
}

/** Discover campaigns for a set of inbox IDs, returns campaign→inboxIds map */
async function discoverCampaigns(inboxIds: number[]) {
  const campaignMap = new Map<number, { name: string; status: string; inboxIds: number[] }>();
  for (let i = 0; i < inboxIds.length; i += 5) {
    const batch = inboxIds.slice(i, i + 5);
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
          for (const c of json.data || []) {
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
        for (const c of r.value.campaigns) {
          if (!campaignMap.has(c.id)) {
            campaignMap.set(c.id, { name: c.name, status: c.status, inboxIds: [] });
          }
          campaignMap.get(c.id)!.inboxIds.push(r.value.inboxId);
        }
      }
    }
    if (i + 5 < inboxIds.length) await delay(200);
  }
  return campaignMap;
}

/**
 * POST /api/deliverability/remove-from-campaigns
 *
 * Phase 1 — Discover: { domains: string[], discover: true }
 *   Returns list of campaigns the inboxes are in (for user to select from)
 *
 * Phase 2 — Remove: { domains: string[], campaignIds: number[] }
 *   Removes inboxes from the selected campaigns (pause → remove → resume)
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { domains, discover, campaignIds } = body as {
      domains: string[];
      discover?: boolean;
      campaignIds?: number[];
    };

    if (!domains?.length) {
      return NextResponse.json({ error: "domains required" }, { status: 400 });
    }

    const inboxIds = await getInboxIdsForDomains(domains);
    if (inboxIds.length === 0) {
      return NextResponse.json(discover ? { campaigns: [], inboxCount: 0 } : { inboxes: 0, campaigns: 0, removed: 0 });
    }

    const campaignMap = await discoverCampaigns(inboxIds);

    // ─── Phase 1: Discover ───
    if (discover) {
      const campaigns = Array.from(campaignMap.entries())
        .map(([id, info]) => ({
          id,
          name: info.name,
          status: info.status,
          inboxCount: info.inboxIds.length,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return NextResponse.json({ campaigns, inboxCount: inboxIds.length });
    }

    // ─── Phase 2: Remove from selected campaigns ───
    if (!campaignIds?.length) {
      return NextResponse.json({ error: "campaignIds required" }, { status: 400 });
    }

    const selectedCampaignIds = new Set(campaignIds);
    let totalRemoved = 0;
    const details: { id: number; name: string; removed: number; error?: string }[] = [];

    for (const [campaignId, info] of campaignMap) {
      if (!selectedCampaignIds.has(campaignId)) continue;

      const wasActive = info.status.toLowerCase() === "active";

      try {
        if (wasActive) {
          await fetch(`${API_BASE}/campaigns/${campaignId}/pause`, { method: "PATCH", headers, cache: "no-store" });
          await delay(500);
        }

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

        if (wasActive) {
          await delay(500);
          await fetch(`${API_BASE}/campaigns/${campaignId}/resume`, { method: "PATCH", headers, cache: "no-store" });
        }

        totalRemoved += removed;
        details.push({ id: campaignId, name: info.name, removed });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        details.push({ id: campaignId, name: info.name, removed: 0, error: msg });
        if (wasActive) {
          try { await fetch(`${API_BASE}/campaigns/${campaignId}/resume`, { method: "PATCH", headers, cache: "no-store" }); } catch { /* best effort */ }
        }
      }
    }

    return NextResponse.json({
      inboxes: inboxIds.length,
      campaigns: details.length,
      removed: totalRemoved,
      details,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
