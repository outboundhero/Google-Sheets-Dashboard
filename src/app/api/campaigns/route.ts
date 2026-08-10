import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getClientTrackerData } from "@/lib/google-sheets";
import { getAllocations } from "@/lib/client-tag-allocations";
import { getClientTiers } from "@/lib/replacement/client-tiers";
import { deriveStage, deriveSetRole, classificationFromName } from "@/lib/campaigns/stage";
import { bisonFetch, resolveInstance, resolveInstances } from "@/lib/bison";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

export interface CampaignData {
  id: number;
  instance: BisonInstanceSlug;
  name: string;
  status: string;
  client_tag: string;
  total_leads: number;
  total_leads_contacted: number;
  remaining_leads: number;
  emails_sent: number;
  replied: number;
  unique_replies: number;
  bounced: number;
  opened: number;
  unique_opens: number;
  interested: number;
  unsubscribed: number;
  completion_percentage: number;
  created_at: string;
  updated_at: string;
  // Extended (Phase 1) — stored on the row where present:
  campaign_type?: string | null;
  sequence_id?: number | null;
  stage?: string | null;
  stage_override?: string | null;
  first_sending_at?: string | null;
  max_emails_per_day?: number | null;
  max_new_leads_per_day?: number | null;
  sender_count?: number | null;
  sched_start_time?: string | null;
  sched_end_time?: string | null;
  sched_timezone?: string | null;
  // Enriched at read-time (not stored):
  classification?: string;
  group?: number | null;
  tier?: string | null;
  effective_stage?: string;
  set_role?: string | null;
  client_start_date?: string | null;
}

// Try Supabase first, fall back to direct API. Returns rows from all requested instances.
async function getFromSupabase(instances: BisonInstanceSlug[]): Promise<CampaignData[] | null> {
  try {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from("campaigns")
      .select("id")
      .in("instance", instances)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) return null; // table doesn't exist
    // Table exists, fetch all
    const all: CampaignData[] = [];
    let offset = 0;
    while (true) {
      const { data: page } = await supabase
        .from("campaigns")
        .select("*")
        .in("instance", instances)
        .order("created_at", { ascending: false })
        .range(offset, offset + 999);
      if (!page || page.length === 0) break;
      all.push(...(page as CampaignData[]));
      if (page.length < 1000) break;
      offset += 1000;
    }
    return all.length > 0 ? all : null;
  } catch {
    return null;
  }
}

async function fetchFromAPI(instance: BisonInstanceSlug): Promise<CampaignData[]> {
  const allCampaigns: CampaignData[] = [];
  // Fetch page 1 to get lastPage count
  const firstRes = await bisonFetch(instance, `/campaigns?page=1&per_page=100`);
  if (!firstRes.ok) throw new Error(`API error: ${firstRes.status}`);
  const firstJson = await firstRes.json();
  const lastPage = firstJson.meta?.last_page || 1;
  const allRaw: Record<string, unknown>[] = [...(firstJson.data || [])];

  // Fetch remaining pages concurrently in batches of 10
  if (lastPage > 1) {
    const pages = Array.from({ length: lastPage - 1 }, (_, i) => i + 2);
    for (let i = 0; i < pages.length; i += 10) {
      const batch = pages.slice(i, i + 10);
      const results = await Promise.allSettled(
        batch.map((p) =>
          bisonFetch(instance, `/campaigns?page=${p}&per_page=100`)
            .then((r) => r.json())
            .then((j) => j.data || [])
        )
      );
      for (const r of results) {
        if (r.status === "fulfilled") allRaw.push(...r.value);
      }
    }
  }

  for (const c of allRaw) {
    const name = c.name as string;
    const colonIdx = name.indexOf(":");
    const clientTag = colonIdx > 0 ? name.substring(0, colonIdx).trim() : "";
    const totalLeads = (c.total_leads as number) || 0;
    const contacted = (c.total_leads_contacted as number) || 0;
    allCampaigns.push({
      id: c.id as number,
      instance,
      name,
      status: c.status as string,
      client_tag: clientTag,
      total_leads: totalLeads,
      total_leads_contacted: contacted,
      remaining_leads: totalLeads - contacted,
      emails_sent: (c.emails_sent as number) || 0,
      replied: (c.replied as number) || 0,
      unique_replies: (c.unique_replies as number) || 0,
      bounced: (c.bounced as number) || 0,
      opened: (c.opened as number) || 0,
      unique_opens: (c.unique_opens as number) || 0,
      interested: (c.interested as number) || 0,
      unsubscribed: (c.unsubscribed as number) || 0,
      completion_percentage: (c.completion_percentage as number) || 0,
      created_at: c.created_at as string,
      updated_at: c.updated_at as string,
    });
  }
  return allCampaigns;
}

// GET — fetch campaigns, filtered to active clients only
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const debug = searchParams.get("debug") === "1";
    const showAll = searchParams.get("all") === "1";
    const instances = resolveInstances(searchParams);

    // Get active client tags from Google Sheet (exclude churned clients with past churn date)
    const tracker = await getClientTrackerData().catch(() => []);
    const now = new Date();

    const activeRows = tracker.filter((r) => {
      if (r.status.trim().toLowerCase() !== "active") return false;
      if (r.churnDate) {
        const churn = new Date(r.churnDate);
        if (!isNaN(churn.getTime()) && churn <= now) {
          // Check if client was re-activated after the churn date
          const reactivated = [r.startDate, r.goLiveDate].some((d) => {
            if (!d) return false;
            const dt = new Date(d);
            return !isNaN(dt.getTime()) && dt > churn;
          });
          if (!reactivated) return false;
        }
      }
      return true;
    });

    const activeClientTags = activeRows
      .flatMap((r) => r.clientAbbr.split(" & ").map((a) => a.trim()))
      .filter(Boolean);

    // Case-insensitive lookup set
    const activeClientsUpper = new Set(activeClientTags.map((t) => t.toUpperCase()));

    // Try Supabase first, fall back to direct API (per-instance, concat results)
    let campaigns = await getFromSupabase(instances);
    if (!campaigns) {
      const apiResults = await Promise.allSettled(instances.map((i) => fetchFromAPI(i)));
      campaigns = apiResults.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    }

    // Collect all unique campaign client_tags for debugging
    const allCampaignTags = [...new Set(campaigns.map((c) => c.client_tag).filter(Boolean))];
    const filteredOutTags = allCampaignTags.filter((t) => !activeClientsUpper.has(t.toUpperCase()));

    // Filter to active clients only — unless ?all=1 is passed (for deliverability bulk operations)
    const filtered = showAll
      ? campaigns.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      : campaigns
          .filter((c) => !c.client_tag || activeClientsUpper.has(c.client_tag.toUpperCase()))
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    // Enrich each campaign with client-level attributes (classification / group /
    // tier / start date, all keyed by client tag) + effective stage + set role.
    const alloc = await getAllocations().catch(() => ({ map: {} as Record<string, number> }));
    const tiers = await getClientTiers().catch(() => new Map<string, string>());
    const classByTag = new Map<string, string>();
    const startByTag = new Map<string, string | null>();
    for (const r of tracker) {
      for (const a of r.clientAbbr.split(" & ")) {
        const k = a.trim().toUpperCase();
        if (!k) continue;
        if (r.classification?.trim()) classByTag.set(k, r.classification.trim());
        if (r.startDate && !startByTag.has(k)) startByTag.set(k, r.startDate);
      }
    }
    const enriched: CampaignData[] = filtered.map((c) => {
      const tagU = (c.client_tag || "").toUpperCase();
      return {
        ...c,
        effective_stage: c.stage_override || c.stage || deriveStage(c.name),
        set_role: deriveSetRole(c.name),
        classification: classByTag.get(tagU) || classificationFromName(c.name) || "",
        group: alloc.map[tagU] ?? null,
        tier: tiers.get(tagU) ?? null,
        client_start_date: startByTag.get(tagU) ?? null,
      };
    });

    const response: Record<string, unknown> = {
      campaigns: enriched,
      activeClients: activeClientTags.sort(),
    };

    // ?debug=1 includes diagnostics in the response
    // ?debug=1&find=BHS shows all tracker rows matching that abbreviation
    if (debug) {
      const findTag = searchParams.get("find")?.toUpperCase();
      const matchingRows = findTag
        ? tracker.filter((r) => r.clientAbbr.toUpperCase().includes(findTag)).map((r) => ({
            abbr: r.clientAbbr,
            companyName: r.companyName,
            status: r.status,
            statusRaw: JSON.stringify(r.status),
            churnDate: r.churnDate,
            startDate: r.startDate,
            goLiveDate: r.goLiveDate,
          }))
        : undefined;
      response._debug = {
        trackerRowCount: tracker.length,
        activeRowCount: activeRows.length,
        ...(matchingRows ? { findResults: matchingRows } : {}),
        activeRows: activeRows.map((r) => ({
          abbr: r.clientAbbr,
          status: r.status,
          churnDate: r.churnDate,
        })),
        activeClientTags: activeClientTags.sort(),
        allCampaignTags: allCampaignTags.sort(),
        filteredOutTags: filteredOutTags.sort(),
        totalCampaigns: campaigns.length,
        filteredCampaigns: filtered.length,
      };
    }

    return NextResponse.json(response);
  } catch (error) {
    console.error("[CAMPAIGNS] Error:", error);
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST — sync from EmailBison API (try to save to Supabase if table exists)
export async function POST(request: Request) {
  const t0 = Date.now();
  try {
    const { searchParams } = new URL(request.url);
    const instance = resolveInstance(searchParams.get("instance"));
    const campaigns = await fetchFromAPI(instance);

    // Try to save to Supabase
    try {
      const supabase = getSupabaseAdmin();
      for (let i = 0; i < campaigns.length; i += 500) {
        await supabase
          .from("campaigns")
          .upsert(
            campaigns.slice(i, i + 500).map((c) => ({ ...c, synced_at: new Date().toISOString() })),
            { onConflict: "instance,id", ignoreDuplicates: false }
          );
      }
    } catch {
      // Supabase table might not exist — that's okay
    }

    console.log(`[CAMPAIGNS:${instance}] Synced ${campaigns.length} in ${Date.now() - t0}ms`);
    return NextResponse.json({ synced: campaigns.length, instance });
  } catch (error) {
    console.error("[CAMPAIGNS] Sync error:", error);
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
