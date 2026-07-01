import { NextResponse } from "next/server";
import { bisonFetch, resolveInstance, resolveInstances } from "@/lib/bison";
import type { BisonInstanceSlug } from "@/lib/bison-instances";
import {
  bisonGetWithRetry,
  fetchSenderEmailIdsByTag,
  fetchCampaignSenderEmails,
  warmupFilterIds,
} from "@/lib/attach-campaigns";

const DELAY_MS = 150;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Tag { id: number; name: string }
interface Campaign { id: number; name: string; status: string }

// 1. Fetch all tags from the given instance → build name→id map
async function fetchTags(instance: BisonInstanceSlug): Promise<Map<string, number>> {
  const res = await bisonFetch(instance, `/tags`);
  if (!res.ok) throw new Error(`Failed to fetch tags: ${res.status}`);
  const json = await res.json();
  const map = new Map<string, number>();
  for (const tag of (json.data || []) as Tag[]) {
    map.set(tag.name, tag.id);
  }
  return map;
}

// 2. Fetch all campaigns via cursor pagination (per_page is fixed at 15 on
//    every Bison endpoint, so cursor is strictly faster than offset here).
async function fetchAllCampaigns(instance: BisonInstanceSlug): Promise<Campaign[]> {
  const all: Campaign[] = [];
  let cursor: string | null = null;
  let guard = 0;
  while (true) {
    if (guard++ > 5000) throw new Error(`campaigns cursor runaway (${instance})`);
    const path = cursor
      ? `/campaigns?pagination_type=cursor&cursor=${encodeURIComponent(cursor)}`
      : `/campaigns?pagination_type=cursor`;
    const res = await bisonGetWithRetry(instance, path);
    const json = await res.json();
    const data: Campaign[] = json?.data || [];
    all.push(...data);
    const nextCursor = json?.meta?.next_cursor ?? null;
    if (!nextCursor || data.length === 0) break;
    cursor = nextCursor;
  }
  return all;
}

// GET: preview — list campaigns with matching tags across the requested
// instances (live from Bison). Supports both single-instance legacy callers
// via ?instance= and multi-instance callers via ?instances=<csv>.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const instances = searchParams.get("instances")
      ? resolveInstances(searchParams)
      : [resolveInstance(searchParams.get("instance"))];

    const statusOrder: Record<string, number> = { Active: 0, Launching: 1, Queued: 2, Draft: 3, Paused: 4, Completed: 5 };

    const results = await Promise.all(
      instances.map(async (instance) => {
        try {
          const [tagMap, campaigns] = await Promise.all([
            fetchTags(instance),
            fetchAllCampaigns(instance),
          ]);
          return campaigns.map((c) => {
            const clientTag = c.name.split(":")[0].trim();
            const tagId = tagMap.get(clientTag);
            return {
              campaign_id: c.id,
              instance,
              campaign_name: c.name,
              client_tag: clientTag,
              tag_id: tagId || null,
              has_tag: !!tagId,
              campaign_status: c.status,
            };
          });
        } catch (e) {
          console.error(`Attach campaigns GET[${instance}]:`, e);
          return [];
        }
      })
    );

    const preview = results
      .flat()
      .filter((c) => c.has_tag)
      .sort((a, b) => {
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


// POST: execute attachment for a single campaign.
//
// Two modes:
//
//  A) SLOW / STANDALONE (backwards-compatible, no pre_matched_ids in body):
//     - Fetch tag → sender IDs from Bison
//     - Warmup-filter against Supabase (≥21d domains only)
//     - Fetch already-attached sender IDs from Bison
//     - Attach the diff
//     - Report exact newly_attached / already_attached counts.
//
//  B) FAST BATCHED (pre_matched_ids supplied by /prepare):
//     - Skip the tag fetch AND the already-attached fetch entirely.
//     - Bison's /attach-sender-emails is idempotent — attaching a duplicate
//       silently no-ops, so the "already attached" check is only useful for
//       counts, not correctness.
//     - Attach the whole pre-matched batch and report total_matched only.
//     Mode B is what the FE dialog uses for large batches — cuts the per-
//     campaign wall-clock from ~15-30s to ~1-3s at 419 campaigns.
export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const instance = resolveInstance(searchParams.get("instance"));
    const body = await request.json();
    const { campaign_id, campaign_name, client_tag, tag_id } = body;
    const preMatchedIds: number[] | undefined = Array.isArray(body?.pre_matched_ids)
      ? body.pre_matched_ids.filter((x: unknown): x is number => typeof x === "number")
      : undefined;

    if (!campaign_id || !tag_id) {
      return NextResponse.json({ error: "campaign_id and tag_id required" }, { status: 400 });
    }

    // ---------- Mode B: fast path, pre-matched IDs supplied ----------
    if (preMatchedIds !== undefined) {
      if (preMatchedIds.length === 0) {
        return NextResponse.json({
          campaign_id,
          instance,
          campaign_name: campaign_name || "",
          total_matched: 0,
          already_attached: 0,
          newly_attached: 0,
        });
      }
      let totalAttached = 0;
      for (let i = 0; i < preMatchedIds.length; i += 100) {
        const batch = preMatchedIds.slice(i, i + 100);
        const attachRes = await bisonFetch(instance, `/campaigns/${campaign_id}/attach-sender-emails`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sender_email_ids: batch }),
        });
        if (attachRes.ok) {
          totalAttached += batch.length;
        } else if (attachRes.status === 422) {
          const errText = await attachRes.text().catch(() => "");
          console.error(`422 attaching to campaign ${campaign_id} (${instance}): ${errText}`);
        } else if (attachRes.status === 404) {
          // Campaign gone in Bison — bail with a real error the FE can show.
          return NextResponse.json({ error: `Campaign ${campaign_id} not found in Bison (stale)` }, { status: 404 });
        } else {
          const errText = await attachRes.text().catch(() => "");
          return NextResponse.json({
            error: `Bison ${attachRes.status} on attach: ${errText.slice(0, 200)}`,
          }, { status: 502 });
        }
        if (i + 100 < preMatchedIds.length) await delay(DELAY_MS);
      }
      // We don't know already_attached vs newly_attached in fast mode. Report
      // total_matched = attached-so-far and newly_attached = total. Bison's
      // idempotent dedup on the server side keeps things consistent.
      return NextResponse.json({
        campaign_id,
        instance,
        campaign_name: campaign_name || "",
        total_matched: preMatchedIds.length,
        already_attached: 0,
        newly_attached: totalAttached,
      });
    }

    // ---------- Mode A: standalone path (legacy / single-campaign use) ----------

    // 1. Get all sender email IDs with this tag from Bison (cursor pagination + retry)
    const allMatchedIds = await fetchSenderEmailIdsByTag(instance, tag_id);

    // 2. Filter to only warmed-up inboxes (domain ≥21d, this instance)
    const matchedIds = await warmupFilterIds(instance, allMatchedIds);
    console.log(`[ATTACH:${instance}] Tag ${client_tag}: ${allMatchedIds.length} total → ${matchedIds.length} warmed-up`);

    if (matchedIds.length === 0) {
      return NextResponse.json({
        campaign_id,
        instance,
        campaign_name: campaign_name || "",
        total_matched: 0,
        already_attached: 0,
        newly_attached: 0,
      });
    }

    // 3. Get ALL already-attached sender emails (cursor pagination + retry)
    const alreadyAttachedIds = await fetchCampaignSenderEmails(instance, campaign_id);

    // 4. Compute new IDs to attach
    const alreadySet = new Set(alreadyAttachedIds);
    const newIds = matchedIds.filter((id) => !alreadySet.has(id));

    if (newIds.length === 0) {
      return NextResponse.json({
        campaign_id,
        instance,
        campaign_name: campaign_name || "",
        total_matched: matchedIds.length,
        already_attached: alreadyAttachedIds.length,
        newly_attached: 0,
      });
    }

    // 5. Attach new inboxes (batch in groups of 100)
    let totalAttached = 0;
    for (let i = 0; i < newIds.length; i += 100) {
      const batch = newIds.slice(i, i + 100);
      const attachRes = await bisonFetch(instance, `/campaigns/${campaign_id}/attach-sender-emails`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender_email_ids: batch }),
      });

      if (attachRes.ok) {
        totalAttached += batch.length;
      } else if (attachRes.status === 422) {
        const errText = await attachRes.text().catch(() => "");
        console.error(`422 attaching to campaign ${campaign_id} (${instance}): ${errText}`);
      }

      if (i + 100 < newIds.length) await delay(DELAY_MS);
    }

    return NextResponse.json({
      campaign_id,
      instance,
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
