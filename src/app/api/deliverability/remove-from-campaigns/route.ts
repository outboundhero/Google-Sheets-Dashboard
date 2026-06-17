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

/**
 * Discover campaigns for a set of inbox IDs in one instance.
 *
 * For each inbox we ask Bison "what campaigns is this in?" via
 * /sender-emails/{id}/campaigns. There's no Bison bulk endpoint for this, so
 * the per-inbox lookup is unavoidable. To keep wall-clock time reasonable on
 * large selections (500-1000+ inboxes) we use a wide worker pool, no
 * inter-batch sleep, and a 429-aware retry so a rate limit on one page doesn't
 * silently drop that inbox's campaigns.
 */
async function discoverCampaigns(instance: BisonInstanceSlug, inboxIds: number[]) {
  const CONC = 25;
  const campaignMap = new Map<number, { name: string; status: string; inboxIds: number[] }>();

  async function fetchPage(inboxId: number, page: number): Promise<{ data?: { id: number; name: string; status: string }[]; meta?: { last_page?: number } } | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await bisonFetch(
        instance,
        `/sender-emails/${inboxId}/campaigns?page=${page}&per_page=100`,
      );
      if (res.status === 429) { await delay(800 * (attempt + 1)); continue; }
      if (!res.ok) return null;
      try { return await res.json(); } catch { return null; }
    }
    return null;
  }

  async function lookup(inboxId: number) {
    const campaigns: { id: number; name: string; status: string }[] = [];
    let page = 1;
    while (true) {
      const json = await fetchPage(inboxId, page);
      if (!json) break;
      for (const c of json.data || []) campaigns.push({ id: c.id, name: c.name, status: c.status });
      if (page >= (json.meta?.last_page || 1)) break;
      page++;
    }
    return { inboxId, campaigns };
  }

  // Simple worker pool over the inboxIds.
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= inboxIds.length) return;
      const { inboxId, campaigns } = await lookup(inboxIds[i]);
      for (const c of campaigns) {
        let entry = campaignMap.get(c.id);
        if (!entry) { entry = { name: c.name, status: c.status, inboxIds: [] }; campaignMap.set(c.id, entry); }
        entry.inboxIds.push(inboxId);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONC, inboxIds.length) }, () => worker()));

  return campaignMap;
}

/**
 * Fetch all sender_email IDs currently attached to a campaign.
 *
 * Bison hard-caps per_page on this endpoint at 15, so large campaigns have
 * many pages. The previous version silently broke the loop on any non-200
 * (e.g. a transient 429) and returned a partial list → the caller's
 * intersection then missed entries and reported "0 removed". This version
 * retries each page up to 3x with backoff, and throws if a page fails after
 * retries so the caller surfaces a real error rather than silently truncating.
 */
async function fetchCampaignSenderIds(instance: BisonInstanceSlug, campaignId: number): Promise<number[]> {
  const ids: number[] = [];
  let page = 1;
  while (true) {
    let attempt = 0;
    let json: { data?: { id: number }[]; meta?: { last_page?: number } } | null = null;
    while (attempt < 3) {
      const res = await bisonFetch(
        instance,
        `/campaigns/${campaignId}/sender-emails?page=${page}&per_page=100`,
      );
      if (res.status === 404) return ids;
      if (res.ok) {
        try { json = await res.json(); break; } catch { /* parse error → retry */ }
      }
      attempt++;
      if (attempt < 3) await delay(800 * attempt);
    }
    if (!json) {
      throw new Error(`failed to fetch campaign ${campaignId} senders page ${page} after retries`);
    }
    for (const item of json.data || []) ids.push(item.id);
    const lastPage = json.meta?.last_page || 1;
    if (page >= lastPage) break;
    page++;
  }
  return ids;
}

/**
 * POST /api/deliverability/remove-from-campaigns?instances=<csv>
 *
 * Phase 1 — Discover: { domains: string[], discover: true }
 *   Returns list of campaigns the inboxes are in across the requested instances.
 *   Each returned campaign carries its source instance.
 *
 * Phase 2 — Remove: { domains: string[], campaigns: { id: number; instance: string; name?: string; status?: string }[] }
 *   Removes inboxes from each selected campaign on its own instance (pause → remove → resume).
 *   Works for both auto-discovered and manually-added campaigns — each campaign's
 *   current senders are fetched fresh from Bison, then intersected with the domain
 *   inboxes, so manual adds aren't blocked by the discovery step.
 */
export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const instances = resolveInstances(searchParams);
    const body = await request.json();
    const { domains, discover, campaigns: removeCampaigns } = body as {
      domains: string[];
      discover?: boolean;
      campaigns?: { id: number; instance: string; name?: string; status?: string; inboxIds?: number[] }[];
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
        // Inbox IDs (from the user's selected domains) that Bison says are
        // attached to this campaign. The FE passes these back in the remove
        // call so the server can skip a slow re-fetch and just delete these
        // exact IDs. Avoids the "0 removed" failure mode we saw when
        // /campaigns/{id}/sender-emails truncates silently mid-pagination.
        inboxIds: number[];
      };
      // Parallelize across instances — most selections only have data in one
      // or two instances, so we can fan out without worrying about API quota.
      const perInstance = await Promise.all(
        instances.map(async (inst) => {
          const inboxIds = await getInboxIdsForDomains(inst, domains);
          if (inboxIds.length === 0) return { inst, inboxCount: 0, campaigns: [] as Discovered[] };
          const campaignMap = await discoverCampaigns(inst, inboxIds);
          const camps: Discovered[] = [];
          for (const [id, info] of campaignMap) {
            camps.push({
              id,
              instance: inst,
              name: info.name,
              status: info.status,
              inboxCount: info.inboxIds.length,
              inboxIds: info.inboxIds,
            });
          }
          return { inst, inboxCount: inboxIds.length, campaigns: camps };
        }),
      );
      const all: Discovered[] = perInstance.flatMap((p) => p.campaigns);
      const totalInboxes = perInstance.reduce((s, p) => s + p.inboxCount, 0);
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

    // Cache the inbox IDs per instance — we only need to look them up once per instance.
    const inboxIdsByInstance = new Map<BisonInstanceSlug, Set<number>>();

    for (const c of removeCampaigns) {
      if (!isInstanceSlug(c.instance)) {
        details.push({ id: c.id, name: c.name || `Campaign ${c.id}`, removed: 0, error: `Unknown instance: ${c.instance}` });
        continue;
      }
      const inst = c.instance;

      // Load (and cache) the domain inbox IDs for this instance
      let inboxIdSet = inboxIdsByInstance.get(inst);
      if (!inboxIdSet) {
        const ids = await getInboxIdsForDomains(inst, domains);
        inboxIdSet = new Set(ids);
        inboxIdsByInstance.set(inst, inboxIdSet);
        totalInboxes += ids.length;
      }

      const campaignName = c.name || `Campaign ${c.id}`;

      if (inboxIdSet.size === 0) {
        details.push({ id: c.id, name: campaignName, removed: 0, error: "No matching inboxes found for selected domains on this instance" });
        continue;
      }

      try {
        // Prefer the FE-supplied inboxIds from discovery — they're the exact
        // set Bison confirmed are attached to this campaign at discovery time,
        // so we can skip a slow re-fetch that's prone to silent truncation.
        // Manually-added campaigns won't have inboxIds → fall back to fetching.
        let toRemove: number[];
        if (Array.isArray(c.inboxIds) && c.inboxIds.length > 0) {
          // Still intersect with the domain-inbox set in case the user
          // deselected domains between discovery and removal.
          toRemove = c.inboxIds.filter((id) => inboxIdSet!.has(id));
        } else {
          const campaignSenders = await fetchCampaignSenderIds(inst, c.id);
          toRemove = campaignSenders.filter((id) => inboxIdSet!.has(id));
        }

        if (toRemove.length === 0) {
          details.push({ id: c.id, name: campaignName, removed: 0 });
          continue;
        }

        const wasActive = (c.status || "").toLowerCase() === "active";

        if (wasActive) {
          await bisonFetch(inst, `/campaigns/${c.id}/pause`, { method: "PATCH" });
          await delay(500);
        }

        let removed = 0;
        for (let i = 0; i < toRemove.length; i += 100) {
          const batch = toRemove.slice(i, i + 100);
          const res = await bisonFetch(inst, `/campaigns/${c.id}/remove-sender-emails`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sender_email_ids: batch }),
          });
          if (res.ok) removed += batch.length;
          if (i + 100 < toRemove.length) await delay(200);
        }

        if (wasActive) {
          await delay(500);
          await bisonFetch(inst, `/campaigns/${c.id}/resume`, { method: "PATCH" });
        }

        totalRemoved += removed;
        details.push({ id: c.id, name: campaignName, removed });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        details.push({ id: c.id, name: campaignName, removed: 0, error: msg });
        if ((c.status || "").toLowerCase() === "active") {
          try { await bisonFetch(inst, `/campaigns/${c.id}/resume`, { method: "PATCH" }); } catch { /* best effort */ }
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
