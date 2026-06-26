import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import { isInstanceSlug, ALL_INSTANCE_SLUGS, type BisonInstanceSlug } from "@/lib/bison-instances";

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

interface DiscoveredCampaign { id: number; instance: BisonInstanceSlug; name: string; status: string; inboxCount: number; inboxIds: number[] }

/** Union of all tag names on the given domains (across instances). The domain's
 *  client tag (e.g. "BHS") is among these, so we filter campaigns to those whose
 *  client tag matches — keeping removal scoped to the domain's own client. */
async function getDomainTags(domains: string[]): Promise<Set<string>> {
  const supabase = getSupabaseAdmin();
  const names = new Set<string>();
  for (let i = 0; i < domains.length; i += 100) {
    const { data } = await supabase
      .from("deliverability_domains")
      .select("tags")
      .in("domain", domains.slice(i, i + 100));
    for (const r of data || []) {
      let tags: unknown = r.tags;
      if (typeof tags === "string") { try { tags = JSON.parse(tags); } catch { tags = []; } }
      for (const t of (tags as unknown[]) || []) {
        const n = t && typeof t === "object" ? (t as { name?: string }).name : t;
        if (n) names.add(String(n).trim());
      }
    }
  }
  return names;
}

/**
 * ACCURATE discovery: for each inbox, ask Bison which campaigns it's actually
 * in (/sender-emails/{id}/campaigns) and collect the campaign → exact inboxIds
 * map. This only surfaces campaigns the domains are genuinely attached to (so
 * the user never picks one they aren't in and gets "0 removed"). It's cheap PER
 * call (an inbox is in only a few campaigns), and the FE keeps each request
 * small by chunking discovery one domain at a time — so it never times out.
 */
async function discoverCampaigns(instance: BisonInstanceSlug, inboxIds: number[]) {
  const CONC = 10;
  const campaignMap = new Map<number, { name: string; status: string; inboxIds: number[] }>();

  async function fetchPage(inboxId: number, page: number): Promise<{ data?: { id: number; name: string; status: string }[]; meta?: { last_page?: number } } | null> {
    for (let a = 0; a < 5; a++) {
      const res = await bisonFetch(instance, `/sender-emails/${inboxId}/campaigns?page=${page}&per_page=100`);
      if (res.status === 404) return { data: [] };
      if (res.ok) { try { return await res.json(); } catch { return null; } }
      // transient (429/5xx) → honor Retry-After, else exp backoff
      const ra = parseInt(res.headers.get("retry-after") || "", 10);
      await delay((Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(8000, 500 * 2 ** a)) + Math.floor(Math.random() * 200));
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
    return campaigns;
  }

  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= inboxIds.length) return;
      const campaigns = await lookup(inboxIds[i]);
      for (const c of campaigns) {
        let entry = campaignMap.get(c.id);
        if (!entry) { entry = { name: c.name, status: c.status, inboxIds: [] }; campaignMap.set(c.id, entry); }
        entry.inboxIds.push(inboxIds[i]);
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
const SENDER_PAGE_RETRIES = 6;
async function fetchCampaignSenderIds(instance: BisonInstanceSlug, campaignId: number): Promise<number[]> {
  const ids: number[] = [];
  let page = 1;
  while (true) {
    let attempt = 0;
    let json: { data?: { id: number }[]; meta?: { last_page?: number } } | null = null;
    while (attempt < SENDER_PAGE_RETRIES) {
      const res = await bisonFetch(
        instance,
        `/campaigns/${campaignId}/sender-emails?page=${page}&per_page=100`,
      );
      if (res.status === 404) return ids;
      if (res.ok) {
        try { json = await res.json(); break; } catch { /* parse error → retry */ }
        attempt++;
        if (attempt < SENDER_PAGE_RETRIES) await delay(600 * 2 ** attempt);
        continue;
      }
      // Transient (rate-limit / 5xx): honor Retry-After, else exponential backoff.
      const ra = parseInt(res.headers.get("retry-after") || "", 10);
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(10000, 600 * 2 ** attempt);
      attempt++;
      if (attempt < SENDER_PAGE_RETRIES) await delay(wait + Math.floor(Math.random() * 300));
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
    const body = await request.json();
    const { domains, discover, campaigns: removeCampaigns } = body as {
      domains: string[];
      discover?: boolean;
      campaigns?: { id: number; instance: string; name?: string; status?: string; inboxIds?: number[] }[];
    };

    if (!domains?.length) {
      return NextResponse.json({ error: "domains required" }, { status: 400 });
    }

    // Discover phase: find the campaigns the domains are ACTUALLY in, across
    // every instance (so a wrong group/tier in the switcher doesn't hide them).
    // The FE calls this one domain at a time (chunked) so each request stays
    // small and never hits the 300s timeout.
    //
    // SCOPED TO THE DOMAIN'S OWN CLIENT TAG: a domain's inboxes can end up
    // attached to OTHER clients' campaigns (cross-client). Removing it from
    // those is almost never intended, so we only surface campaigns whose client
    // tag (name prefix before ":") matches one of the domain's tags. Pass
    // allClients=true to bypass and show every campaign it's in.
    if (discover) {
      const showAllClients = (body as { allClients?: boolean }).allClients === true;
      const domainTags = showAllClients ? null : await getDomainTags(domains);
      const perInstance = await Promise.all(
        ALL_INSTANCE_SLUGS.map(async (inst) => {
          const inboxIds = await getInboxIdsForDomains(inst, domains);
          if (inboxIds.length === 0) return [] as DiscoveredCampaign[];
          const campaignMap = await discoverCampaigns(inst, inboxIds);
          return Array.from(campaignMap).map(([id, info]) => ({
            id, instance: inst, name: info.name, status: info.status,
            inboxCount: info.inboxIds.length, inboxIds: info.inboxIds,
          }));
        }),
      );
      let all = perInstance.flat();
      if (domainTags) {
        all = all.filter((c) => domainTags.has(c.name.split(":")[0].trim()));
      }
      all.sort((a, b) => a.name.localeCompare(b.name));
      return NextResponse.json({ campaigns: all });
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
      const campaignName = c.name || `Campaign ${c.id}`;
      const discoveryIds = Array.isArray(c.inboxIds) ? Array.from(new Set(c.inboxIds)) : [];

      try {
        let toRemove: number[];
        if (discoveryIds.length > 0) {
          // Trust the inbox IDs confirmed at discovery (domain ∩ campaign).
          // Do NOT re-derive from `domains` here: the domain selection in the
          // UI can be cleared between discovery and remove (e.g. onComplete
          // resets it), which used to make this silently remove nothing.
          toRemove = discoveryIds;
          totalInboxes += discoveryIds.length;
        } else {
          // Manually-added campaign (no discovery IDs) → resolve via the
          // selected domains, fetching the campaign's senders live.
          let inboxIdSet = inboxIdsByInstance.get(inst);
          if (!inboxIdSet) {
            const ids = await getInboxIdsForDomains(inst, domains);
            inboxIdSet = new Set(ids);
            inboxIdsByInstance.set(inst, inboxIdSet);
            totalInboxes += ids.length;
          }
          if (inboxIdSet.size === 0) {
            details.push({ id: c.id, name: campaignName, removed: 0, error: "No matching inboxes found for selected domains on this instance" });
            continue;
          }
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
