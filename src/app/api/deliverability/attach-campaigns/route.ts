import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

const API_BASE = "https://app.outboundhero.co/api";
const API_KEY = process.env.OUTBOUNDHERO_API_KEY!;
const DELAY_MS = 300;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Campaign {
  id: number;
  name: string;
  status: string;
  type: string;
}

// Fetch all campaigns (paginated)
async function fetchAllCampaigns(): Promise<Campaign[]> {
  const all: Campaign[] = [];
  let page = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fetch(`${API_BASE}/campaigns?page=${page}&per_page=100`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      cache: "no-store",
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

// Fetch ALL sender emails for a campaign (paginated)
async function fetchCampaignSenderEmails(campaignId: number): Promise<number[]> {
  const allIds: number[] = [];
  let page = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fetch(
      `${API_BASE}/campaigns/${campaignId}/sender-emails?page=${page}&per_page=100`,
      { headers: { Authorization: `Bearer ${API_KEY}` }, cache: "no-store" }
    );
    if (!res.ok) break;
    const json = await res.json();
    const data = json.data || [];
    if (data.length === 0) break;
    allIds.push(...data.map((e: { id: number }) => e.id));
    const lastPage = json.meta?.last_page || 1;
    if (page >= lastPage) break;
    page++;
    await delay(150);
  }
  return allIds;
}

// Extract invalid IDs from a 422 error response
function extractInvalidIds(errorBody: string, ids: number[]): Set<number> {
  const invalid = new Set<number>();
  try {
    const parsed = JSON.parse(errorBody);
    const errors = parsed?.data?.errors || parsed?.errors || {};
    for (const key of Object.keys(errors)) {
      // key is like "sender_email_ids.23" — extract the index
      const match = key.match(/sender_email_ids\.(\d+)/);
      if (match) {
        const idx = parseInt(match[1], 10);
        if (idx < ids.length) invalid.add(ids[idx]);
      }
    }
  } catch { /* ignore parse errors */ }
  return invalid;
}

// GET: preview — list campaigns with matching inbox counts
export async function GET() {
  try {
    const campaigns = await fetchAllCampaigns();
    const supabase = getSupabaseAdmin();

    const preview = await Promise.all(
      campaigns.map(async (c) => {
        const clientTag = c.name.split(":")[0].trim();
        const { count } = await supabase
          .from("deliverability_inboxes")
          .select("*", { count: "exact", head: true })
          .contains("tags", JSON.stringify([{ name: clientTag }]));

        return {
          campaign_id: c.id,
          campaign_name: c.name,
          client_tag: clientTag,
          matching_count: count || 0,
          campaign_status: c.status,
        };
      })
    );

    return NextResponse.json(preview);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load campaigns";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST: execute attachment for a single campaign
export async function POST(request: Request) {
  try {
    const { campaign_id, campaign_name, client_tag } = await request.json();
    if (!campaign_id || !client_tag) {
      return NextResponse.json({ error: "campaign_id and client_tag required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();

    // 1. Get matching inbox IDs from Supabase
    const { data: matchedInboxes } = await supabase
      .from("deliverability_inboxes")
      .select("id")
      .contains("tags", JSON.stringify([{ name: client_tag }]));

    const matchedIds = (matchedInboxes || []).map((i) => i.id);

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

    // 4. Attach new inboxes (batch in groups of 100, retry on 422 with invalid IDs removed)
    let totalAttached = 0;
    const allInvalidIds = new Set<number>();

    for (let i = 0; i < newIds.length; i += 100) {
      let batch = newIds.slice(i, i + 100).filter((id) => !allInvalidIds.has(id));
      if (batch.length === 0) continue;

      const attachRes = await fetch(`${API_BASE}/campaigns/${campaign_id}/attach-sender-emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sender_email_ids: batch }),
      });

      if (attachRes.status === 422) {
        // Extract invalid IDs, remove them, and retry
        const errText = await attachRes.text().catch(() => "");
        const invalidInBatch = extractInvalidIds(errText, batch);
        for (const id of invalidInBatch) allInvalidIds.add(id);
        batch = batch.filter((id) => !invalidInBatch.has(id));

        if (batch.length > 0) {
          const retryRes = await fetch(`${API_BASE}/campaigns/${campaign_id}/attach-sender-emails`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ sender_email_ids: batch }),
          });
          if (retryRes.ok) totalAttached += batch.length;
        }
      } else if (attachRes.ok) {
        totalAttached += batch.length;
      }

      if (i + 100 < newIds.length) await delay(DELAY_MS);
    }

    return NextResponse.json({
      campaign_id,
      campaign_name: campaign_name || "",
      total_matched: matchedIds.length,
      already_attached: alreadyAttachedIds.length,
      newly_attached: totalAttached,
      skipped_invalid: allInvalidIds.size,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Attachment failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
