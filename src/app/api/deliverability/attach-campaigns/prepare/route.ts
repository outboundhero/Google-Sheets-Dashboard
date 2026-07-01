import { NextResponse } from "next/server";
import { resolveInstance } from "@/lib/bison";
import {
  fetchSenderEmailIdsByTag,
  getWarmedUpDomainSet,
  warmupFilterIds,
  mapConcurrent,
} from "@/lib/attach-campaigns";

// Even chunked FE-side (~15 tags per call), a single tag with a lot of
// senders across many pages can push a chunk past the 60s default. Cap at
// the 300s Vercel Pro ceiling so a slow tag can't kill the whole request.
export const maxDuration = 300;

// POST /api/deliverability/attach-campaigns/prepare?instance=<slug>
// Body: { tag_ids: number[] }
// Returns: { tags: { [tag_id_string]: number[] } }
//
// Why this exists:
// The FE dialog previously called the per-campaign POST sequentially for 419
// campaigns — each POST re-ran the same tag → sender-emails walk (~15-30s
// each because per_page on Bison is fixed at 15 and a client tag can have
// many hundreds of inboxes). Multiple campaigns for the same client tag were
// duplicating that work.
//
// This route dedups by unique (instance, tag_id), fans the tag walks out at
// concurrency=4, and returns the warmed-up sender IDs per tag. The FE then
// runs the per-campaign POSTs in parallel with `pre_matched_ids` already in
// hand, so each per-campaign POST is just the /attach-sender-emails calls.
export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const instance = resolveInstance(searchParams.get("instance"));
    const body = await request.json();
    const rawIds: unknown = body?.tag_ids;
    if (!Array.isArray(rawIds)) {
      return NextResponse.json({ error: "tag_ids: number[] required" }, { status: 400 });
    }
    // Dedup + coerce to numbers
    const tagIds = Array.from(
      new Set(rawIds.filter((v): v is number => typeof v === "number" && Number.isFinite(v))),
    );
    if (tagIds.length === 0) {
      return NextResponse.json({ tags: {} });
    }

    // Load warmed-up domain set ONCE (not per tag). Cuts N × table-scan → 1.
    const warmedUpDomains = await getWarmedUpDomainSet(instance);

    // Fetch each tag → sender IDs concurrently, warmup-filter server-side.
    // Concurrency=4 is a compromise: high enough to hide per-tag cursor latency,
    // low enough to stay well below Bison's rate limit ceiling and leave room
    // for the FE's concurrent per-campaign POSTs during the attach phase.
    const results = await mapConcurrent(tagIds, 4, async (tagId) => {
      try {
        const allIds = await fetchSenderEmailIdsByTag(instance, tagId);
        const filtered = await warmupFilterIds(instance, allIds, warmedUpDomains);
        return { tagId, ids: filtered, ok: true as const };
      } catch (e) {
        console.error(`[prepare:${instance}] tag ${tagId} failed:`, e);
        return { tagId, ids: [] as number[], ok: false as const, error: e instanceof Error ? e.message : "failed" };
      }
    });

    const tags: Record<string, number[]> = {};
    const failed: { tag_id: number; error?: string }[] = [];
    for (const r of results) {
      tags[String(r.tagId)] = r.ids;
      if (!r.ok) failed.push({ tag_id: r.tagId, error: r.error });
    }

    return NextResponse.json({ instance, tags, ...(failed.length ? { failed } : {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Prepare failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
