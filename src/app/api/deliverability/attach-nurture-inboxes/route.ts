import { NextResponse } from "next/server";
import { bisonFetch } from "@/lib/bison";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

// Attaches sender inboxes to every "[Nurture] (Cleaning Client)" campaign in
// the outboundhero Bison instance. Pulls campaigns + tags + senders live from
// Bison (NOT from Supabase — that table has stale campaign rows), maps each
// campaign's "<TAG>:" prefix to a Bison tag id, fetches senders for that tag,
// and attaches the ones that aren't already on the campaign.
//
// Resumable: time-budgeted to fit Vercel's 60s function limit. Each call
// returns `nextResumeFrom` (a campaign id). Re-hit with ?resumeFrom=<id> until
// `done: true`.

export const maxDuration = 60;

const INSTANCE: BisonInstanceSlug = "outboundhero";
const NAME_NEEDLE = "[Nurture] (Cleaning Client)";
const ATTACH_BATCH = 100;
const SENDER_PER_PAGE = 100;
const CAMPAIGN_PER_PAGE = 100;
const TIME_BUDGET_MS = 50_000;
const PACE_MS = 100;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface BisonCampaign { id: number; name: string; status: string }
interface BisonTag { id: number; name: string }
interface BisonSenderEmail { id: number }

interface CampaignReport {
  id: number;
  name: string;
  status: string;
  clientTag: string;
  tagId: number | null;
  totalSendersForTag: number;
  alreadyAttached: number;
  newlyAttached: number;
  failed: number;
  error: string | null;
  skipped: string | null;
  dryRun: boolean;
}

async function fetchTagMap(instance: BisonInstanceSlug): Promise<Map<string, number>> {
  const res = await bisonFetch(instance, `/tags`);
  if (!res.ok) throw new Error(`Failed to fetch tags: ${res.status}`);
  const json = await res.json();
  const list: BisonTag[] = json.data || [];
  const map = new Map<string, number>();
  // Index by uppercased name so casing differences ("ABM" vs "abm") don't miss.
  for (const t of list) map.set(t.name.trim().toUpperCase(), t.id);
  return map;
}

async function fetchAllCampaigns(instance: BisonInstanceSlug): Promise<BisonCampaign[]> {
  const all: BisonCampaign[] = [];
  let page = 1;
  while (true) {
    const res = await bisonFetch(instance, `/campaigns?page=${page}&per_page=${CAMPAIGN_PER_PAGE}`);
    if (!res.ok) throw new Error(`Failed to fetch campaigns page ${page}: ${res.status}`);
    const json = await res.json();
    const data: BisonCampaign[] = json.data || [];
    all.push(...data);
    const lastPage = json.meta?.last_page || 1;
    if (page >= lastPage || data.length === 0) break;
    page++;
    await delay(PACE_MS);
  }
  return all;
}

async function fetchSenderIdsByTag(instance: BisonInstanceSlug, tagId: number): Promise<number[]> {
  const ids: number[] = [];
  let page = 1;
  while (true) {
    const res = await bisonFetch(
      instance,
      `/sender-emails?tag_ids[]=${tagId}&page=${page}&per_page=${SENDER_PER_PAGE}`,
    );
    if (!res.ok) throw new Error(`Failed to fetch senders for tag ${tagId} page ${page}: ${res.status}`);
    const json = await res.json();
    const payload = Array.isArray(json) ? json[0] : json;
    const data: BisonSenderEmail[] = payload.data || [];
    if (data.length === 0) break;
    ids.push(...data.map((e) => e.id));
    const lastPage = payload.meta?.last_page || 1;
    if (page >= lastPage) break;
    page++;
    await delay(PACE_MS);
  }
  return ids;
}

async function fetchAttachedSenderIds(instance: BisonInstanceSlug, campaignId: number): Promise<Set<number>> {
  const ids = new Set<number>();
  let page = 1;
  while (true) {
    const res = await bisonFetch(
      instance,
      `/campaigns/${campaignId}/sender-emails?page=${page}&per_page=${SENDER_PER_PAGE}`,
    );
    if (!res.ok) {
      // Campaign-level 404 (campaign was just deleted) returns no attached set —
      // caller will surface this as the attach failing.
      if (res.status === 404) return ids;
      throw new Error(`Failed to fetch attached senders for campaign ${campaignId} page ${page}: ${res.status}`);
    }
    const json = await res.json();
    const data: BisonSenderEmail[] = json.data || [];
    if (data.length === 0) break;
    for (const e of data) ids.add(e.id);
    const lastPage = json.meta?.last_page || 1;
    if (page >= lastPage) break;
    page++;
    await delay(PACE_MS);
  }
  return ids;
}

interface AttachOutcome { attached: number; failed: number; errorMsg: string | null }

async function attachBatched(
  instance: BisonInstanceSlug,
  campaignId: number,
  ids: number[],
): Promise<AttachOutcome> {
  let attached = 0;
  let failed = 0;
  let errorMsg: string | null = null;

  for (let i = 0; i < ids.length; i += ATTACH_BATCH) {
    const batch = ids.slice(i, i + ATTACH_BATCH);
    try {
      const res = await bisonFetch(instance, `/campaigns/${campaignId}/attach-sender-emails`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender_email_ids: batch }),
      });
      if (res.ok) {
        // Bison's 2xx doesn't return per-id counts — we've already filtered to
        // not-yet-attached, so a 2xx means the whole batch went through.
        attached += batch.length;
      } else if (res.status === 422) {
        // Drop to single-id to isolate bad IDs in this batch.
        for (const id of batch) {
          try {
            const sr = await bisonFetch(instance, `/campaigns/${campaignId}/attach-sender-emails`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sender_email_ids: [id] }),
            });
            if (sr.ok) attached++;
            else failed++;
          } catch {
            failed++;
          }
        }
      } else {
        const text = await res.text().catch(() => "");
        failed += batch.length;
        if (!errorMsg) errorMsg = `Bison ${res.status}: ${text.slice(0, 200)}`;
      }
    } catch (e) {
      failed += batch.length;
      if (!errorMsg) errorMsg = e instanceof Error ? e.message : "request failed";
    }
    if (i + ATTACH_BATCH < ids.length) await delay(PACE_MS);
  }

  return { attached, failed, errorMsg };
}

export async function runAttachNurture(searchParams: URLSearchParams) {
  const startedAt = Date.now();
  const dryRun = searchParams.get("dryRun") !== "0";
  const resumeFromRaw = searchParams.get("resumeFrom");
  const resumeFrom = resumeFromRaw ? Number(resumeFromRaw) : 0;

  // Live source-of-truth pulls. Both run before any per-campaign work so we
  // know the total denominator and can map tag names → ids.
  const [tagMap, allCampaigns] = await Promise.all([
    fetchTagMap(INSTANCE),
    fetchAllCampaigns(INSTANCE),
  ]);

  const eligible = allCampaigns
    .filter((c) => c.status !== "archived" && (c.name || "").includes(NAME_NEEDLE))
    .sort((a, b) => a.id - b.id);

  const totalCampaigns = eligible.length;
  const startIdx =
    Number.isFinite(resumeFrom) && resumeFrom > 0
      ? eligible.findIndex((c) => c.id >= resumeFrom)
      : 0;
  const alreadyDoneBeforeThisRun = startIdx < 0 ? totalCampaigns : startIdx;
  const todo = startIdx < 0 ? [] : eligible.slice(startIdx);

  // Same tag spans multiple campaigns (Gmail / Outlook / SEGs variants).
  // Cache the sender-id list per tag so we don't refetch hundreds of pages.
  const sendersByTagId = new Map<number, number[]>();

  const reports: CampaignReport[] = [];
  let nextResumeFrom: number | null = null;

  for (const c of todo) {
    if (!dryRun && Date.now() - startedAt > TIME_BUDGET_MS) {
      nextResumeFrom = c.id;
      break;
    }

    const tag = ((c.name || "").split(":")[0] || "").trim();
    const base: CampaignReport = {
      id: c.id,
      name: c.name,
      status: c.status,
      clientTag: tag,
      tagId: null,
      totalSendersForTag: 0,
      alreadyAttached: 0,
      newlyAttached: 0,
      failed: 0,
      error: null,
      skipped: null,
      dryRun,
    };

    if (!tag) {
      base.skipped = "campaign name has no client tag prefix (no ':')";
      reports.push(base);
      continue;
    }

    const tagId = tagMap.get(tag.toUpperCase()) ?? null;
    if (!tagId) {
      base.skipped = `tag "${tag}" not found in Bison`;
      reports.push(base);
      continue;
    }
    base.tagId = tagId;

    let senderIds = sendersByTagId.get(tagId);
    if (!senderIds) {
      try {
        senderIds = await fetchSenderIdsByTag(INSTANCE, tagId);
        sendersByTagId.set(tagId, senderIds);
      } catch (e) {
        base.error = `fetch senders failed: ${e instanceof Error ? e.message : "unknown"}`;
        reports.push(base);
        continue;
      }
    }

    base.totalSendersForTag = senderIds.length;
    if (senderIds.length === 0) {
      base.skipped = `no senders in Bison tagged "${tag}"`;
      reports.push(base);
      continue;
    }

    if (dryRun) {
      reports.push(base);
      continue;
    }

    let alreadySet: Set<number>;
    try {
      alreadySet = await fetchAttachedSenderIds(INSTANCE, c.id);
    } catch (e) {
      base.error = `fetch attached failed: ${e instanceof Error ? e.message : "unknown"}`;
      reports.push(base);
      continue;
    }

    const newIds = senderIds.filter((id) => !alreadySet.has(id));
    base.alreadyAttached = senderIds.length - newIds.length;

    if (newIds.length === 0) {
      reports.push(base);
      continue;
    }

    const outcome = await attachBatched(INSTANCE, c.id, newIds);
    base.newlyAttached = outcome.attached;
    base.failed = outcome.failed;
    base.error = outcome.errorMsg;
    reports.push(base);
  }

  const totals = {
    campaigns: reports.length,
    campaignsActionable: reports.filter((r) => !r.skipped).length,
    sendersConsidered: reports.reduce((s, r) => s + r.totalSendersForTag, 0),
    newlyAttached: reports.reduce((s, r) => s + r.newlyAttached, 0),
    alreadyAttached: reports.reduce((s, r) => s + r.alreadyAttached, 0),
    failed: reports.reduce((s, r) => s + r.failed, 0),
  };

  const completedSoFar = alreadyDoneBeforeThisRun + reports.length;
  const remaining = Math.max(0, totalCampaigns - completedSoFar);
  const progress = {
    totalCampaigns,
    completedSoFar,
    remaining,
    percentComplete:
      totalCampaigns > 0 ? Math.round((completedSoFar / totalCampaigns) * 1000) / 10 : 100,
    processedThisRun: reports.length,
  };

  return {
    instance: INSTANCE,
    dryRun,
    done: nextResumeFrom === null,
    nextResumeFrom,
    progress,
    totalsThisRun: totals,
    durationMs: Date.now() - startedAt,
    campaigns: reports,
    generatedAt: new Date().toISOString(),
  };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const result = await runAttachNurture(searchParams);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
