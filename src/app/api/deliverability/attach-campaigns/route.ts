import { NextResponse } from "next/server";

const API_BASE = "https://app.outboundhero.co/api";
const API_KEY = process.env.OUTBOUNDHERO_API_KEY!;
const DELAY_MS = 150;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const headers = { Authorization: `Bearer ${API_KEY}` };

interface Tag { id: number; name: string }
interface Campaign { id: number; name: string; status: string }

// 1. Fetch all tags from OutboundHero → build name→id map
async function fetchTags(): Promise<Map<string, number>> {
  const res = await fetch(`${API_BASE}/tags`, { headers, cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch tags: ${res.status}`);
  const json = await res.json();
  const map = new Map<string, number>();
  for (const tag of (json.data || []) as Tag[]) {
    map.set(tag.name, tag.id);
  }
  return map;
}

// 2. Fetch all campaigns (paginated)
async function fetchAllCampaigns(): Promise<Campaign[]> {
  const all: Campaign[] = [];
  let page = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fetch(`${API_BASE}/campaigns?page=${page}&per_page=100`, {
      headers, cache: "no-store",
    });
    if (!res.ok) throw new Error(`Failed to fetch campaigns: ${res.status}`);
    const json = await res.json();
    const data: Campaign[] = json.data || [];
    all.push(...data);
    const lastPage = json.meta?.last_page || 1;
    if (page >= lastPage) break;
    page++;
    await delay(DELAY_MS);
  }
  return all;
}

// 3. Fetch ALL sender email IDs filtered by tag_id from OutboundHero (paginated)
async function fetchSenderEmailIdsByTag(tagId: number): Promise<number[]> {
  const allIds: number[] = [];
  let page = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url = `${API_BASE}/sender-emails?tag_ids[]=${tagId}&page=${page}&per_page=15`;
    const res = await fetch(url, { headers, cache: "no-store" });
    if (!res.ok) break;
    const json = await res.json();
    const payload = Array.isArray(json) ? json[0] : json;
    const data = payload.data || [];
    if (data.length === 0) break;
    allIds.push(...data.map((e: { id: number }) => e.id));
    const lastPage = payload.meta?.last_page || 1;
    if (page >= lastPage) break;
    page++;
    await delay(100);
  }
  return allIds;
}

// 4. Fetch ALL already-attached sender emails for a campaign (paginated)
async function fetchCampaignSenderEmails(campaignId: number): Promise<number[]> {
  const allIds: number[] = [];
  let page = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fetch(
      `${API_BASE}/campaigns/${campaignId}/sender-emails?page=${page}&per_page=100`,
      { headers, cache: "no-store" }
    );
    if (!res.ok) break;
    const json = await res.json();
    const data = json.data || [];
    if (data.length === 0) break;
    allIds.push(...data.map((e: { id: number }) => e.id));
    const lastPage = json.meta?.last_page || 1;
    if (page >= lastPage) break;
    page++;
    await delay(100);
  }
  return allIds;
}

// GET: preview — list campaigns with matching inbox counts (all from OutboundHero, no Supabase)
export async function GET() {
  try {
    const [tagMap, campaigns] = await Promise.all([fetchTags(), fetchAllCampaigns()]);

    // For preview, just check if the tag exists — count will be fetched during POST
    const preview = campaigns.map((c) => {
      const clientTag = c.name.split(":")[0].trim();
      const tagId = tagMap.get(clientTag);
      return {
        campaign_id: c.id,
        campaign_name: c.name,
        client_tag: clientTag,
        tag_id: tagId || null,
        has_tag: !!tagId,
        campaign_status: c.status,
      };
    }).filter((c) => c.has_tag);

    // Sort: Active first, then by name
    const statusOrder: Record<string, number> = { Active: 0, Launching: 1, Queued: 2, Draft: 3, Paused: 4, Completed: 5 };
    preview.sort((a, b) => {
      const oa = statusOrder[a.campaign_status] ?? 99;
      const ob = statusOrder[b.campaign_status] ?? 99;
      if (oa !== ob) return oa - ob;
      return a.campaign_name.localeCompare(b.campaign_name);
    });

    return NextResponse.json(preview);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load campaigns";
    console.error("Attach campaigns GET error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}


// POST: execute attachment for a single campaign
export async function POST(request: Request) {
  try {
    const { campaign_id, campaign_name, client_tag, tag_id } = await request.json();
    if (!campaign_id || !tag_id) {
      return NextResponse.json({ error: "campaign_id and tag_id required" }, { status: 400 });
    }

    // 1. Get all sender email IDs with this tag from OutboundHero
    const matchedIds = await fetchSenderEmailIdsByTag(tag_id);

    if (matchedIds.length === 0) {
      return NextResponse.json({
        campaign_id,
        campaign_name: campaign_name || "",
        total_matched: 0,
        already_attached: 0,
        newly_attached: 0,
      });
    }

    // 2. Get ALL already-attached sender emails (paginated)
    const alreadyAttachedIds = await fetchCampaignSenderEmails(campaign_id);

    // 3. Compute new IDs to attach
    const alreadySet = new Set(alreadyAttachedIds);
    const newIds = matchedIds.filter((id) => !alreadySet.has(id));

    if (newIds.length === 0) {
      return NextResponse.json({
        campaign_id,
        campaign_name: campaign_name || "",
        total_matched: matchedIds.length,
        already_attached: alreadyAttachedIds.length,
        newly_attached: 0,
      });
    }

    // 4. Attach new inboxes (batch in groups of 100)
    let totalAttached = 0;
    for (let i = 0; i < newIds.length; i += 100) {
      const batch = newIds.slice(i, i + 100);
      const attachRes = await fetch(`${API_BASE}/campaigns/${campaign_id}/attach-sender-emails`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ sender_email_ids: batch }),
      });

      if (attachRes.ok) {
        totalAttached += batch.length;
      } else if (attachRes.status === 422) {
        // Some IDs invalid — skip this batch (already filtered by tag from live API)
        const errText = await attachRes.text().catch(() => "");
        console.error(`422 attaching to campaign ${campaign_id}: ${errText}`);
      }

      if (i + 100 < newIds.length) await delay(DELAY_MS);
    }

    return NextResponse.json({
      campaign_id,
      campaign_name: campaign_name || "",
      total_matched: matchedIds.length,
      already_attached: alreadyAttachedIds.length,
      newly_attached: totalAttached,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Attachment failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
