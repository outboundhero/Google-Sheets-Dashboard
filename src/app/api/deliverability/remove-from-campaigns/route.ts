import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch, resolveInstances } from "@/lib/bison";
import { isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";

export const maxDuration = 300;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Get inbox IDs for given domains from Supabase (scoped to instance) */
async function getInboxIdsForDomains(instance: BisonInstanceSlug, domains: string[]): Promise<number[]> {
  const supabase = getSupabaseAdmin();
  const ids: number[] = [];
  for (let i = 0; i < domains.length; i += 20) {
    const batch = domains.slice(i, i + 20);
    let offset = 0;
    while (true) {
      const { data } = await supabase
        .from("deliverability_inboxes")
        .select("id")
        .eq("instance", instance)
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
async function discoverCampaigns(instance: BisonInstanceSlug, inboxIds: number[]) {
  const campaignMap = new Map<number, { name: string; status: string; inboxIds: number[] }>();
  for (let i = 0; i < inboxIds.length; i += 5) {
    const batch = inboxIds.slice(i, i + 5);
    const results = await Promise.allSettled(
      batch.map(async (inboxId) => {
        const campaigns: { id: number; name: string; status: string }[] = [];
        let page = 1;
        while (true) {
          const res = await bisonFetch(
            instance,
            `/sender-emails/${inboxId}/campaigns?page=${page}&per_page=100`,
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
 * POST /api/deliverability/remove-from-campaigns?instances=<csv>
 *
 * Phase 1 — Discover: { domains: string[], discover: true }
 *   Returns list of campaigns the inboxes are in across the requested instances.
 *   Each returned campaign carries its source instance.
 *
 * Phase 2 — Remove: { domains: string[], campaigns: { id: number; instance: string }[] }
 *   Removes inboxes from the selected campaigns on each campaign's own instance
 *   (pause → remove → resume).
 */
export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const instances = resolveInstances(searchParams);
    const body = await request.json();
    const { domains, discover, campaigns: removeCampaigns } = body as {
      domains: string[];
      discover?: boolean;
      campaigns?: { id: number; instance: string }[];
    };

    if (!domains?.length) {
      return NextResponse.json({ error: "domains required" }, { status: 400 });
    }

    // Discover phase: scan each instance for inboxes + campaigns, merge results.
    if (discover) {
      type Discovered = {
        id: number;
        instance: BisonInstanceSlug;
        name: string;
        status: string;
        inboxCount: number;
      };
      const all: Discovered[] = [];
      let totalInboxes = 0;
      for (const inst of instances) {
        const inboxIds = await getInboxIdsForDomains(inst, domains);
        if (inboxIds.length === 0) continue;
        totalInboxes += inboxIds.length;
        const campaignMap = await discoverCampaigns(inst, inboxIds);
        for (const [id, info] of campaignMap) {
          all.push({
            id,
            instance: inst,
            name: info.name,
            status: info.status,
            inboxCount: info.inboxIds.length,
          });
        }
      }
      all.sort((a, b) => a.name.localeCompare(b.name));
      return NextResponse.json({ campaigns: all, inboxCount: totalInboxes });
    }

    // ─── Phase 2: Remove from selected campaigns ───
    if (!removeCampaigns?.length) {
      return NextResponse.json({ error: "campaigns required" }, { status: 400 });
    }

    let totalRemoved = 0;
    let totalInboxes = 0;
    const details: { id: number; name: string; removed: number; error?: string }[] = [];

    // Group selected campaigns by their instance, then process each instance once.
    const byInstance = new Map<BisonInstanceSlug, Set<number>>();
    for (const c of removeCampaigns) {
      if (!isInstanceSlug(c.instance)) continue;
      if (!byInstance.has(c.instance)) byInstance.set(c.instance, new Set());
      byInstance.get(c.instance)!.add(c.id);
    }

    for (const [inst, selectedIds] of byInstance) {
      const inboxIds = await getInboxIdsForDomains(inst, domains);
      if (inboxIds.length === 0) continue;
      totalInboxes += inboxIds.length;
      const campaignMap = await discoverCampaigns(inst, inboxIds);

      for (const [campaignId, info] of campaignMap) {
        if (!selectedIds.has(campaignId)) continue;

        const wasActive = info.status.toLowerCase() === "active";

        try {
          if (wasActive) {
            await bisonFetch(inst, `/campaigns/${campaignId}/pause`, { method: "PATCH" });
            await delay(500);
          }

          let removed = 0;
          for (let i = 0; i < info.inboxIds.length; i += 100) {
            const batch = info.inboxIds.slice(i, i + 100);
            const res = await bisonFetch(inst, `/campaigns/${campaignId}/remove-sender-emails`, {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sender_email_ids: batch }),
            });
            if (res.ok) removed += batch.length;
            if (i + 100 < info.inboxIds.length) await delay(200);
          }

          if (wasActive) {
            await delay(500);
            await bisonFetch(inst, `/campaigns/${campaignId}/resume`, { method: "PATCH" });
          }

          totalRemoved += removed;
          details.push({ id: campaignId, name: info.name, removed });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          details.push({ id: campaignId, name: info.name, removed: 0, error: msg });
          if (wasActive) {
            try { await bisonFetch(inst, `/campaigns/${campaignId}/resume`, { method: "PATCH" }); } catch { /* best effort */ }
          }
        }
      }
    }

    return NextResponse.json({
      inboxes: totalInboxes,
      campaigns: details.length,
      removed: totalRemoved,
      details,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
