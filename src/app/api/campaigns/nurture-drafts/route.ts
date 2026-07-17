import { NextResponse } from "next/server";
import { bisonGetWithRetry, fetchCampaignSenderEmails } from "@/lib/attach-campaigns";
import { ALL_INSTANCE_SLUGS, type BisonInstanceSlug } from "@/lib/bison-instances";

// GET /api/campaigns/nurture-drafts (admin-only)
//
// Surfaces nurture campaigns that are READY TO ACTIVATE across all 4 Bison
// instances: name contains "[Nurture]", status === "draft", >= 100 leads, and
// >= 10 attached sender inboxes. Leads/status/name come free on the campaign
// list; the sender-inbox count does NOT — so we pre-filter to the small
// candidate set first, then fetch sender counts only for those.
export const maxDuration = 120;

const MIN_LEADS = 100;
const MIN_SENDERS = 10;
const SENDER_CONCURRENCY = 5; // per-instance candidate sender-count batches

interface RawCampaign { id: number; name: string; status: string; total_leads?: number }
export interface NurtureDraft { instance: BisonInstanceSlug; id: number; name: string; leads: number; senders: number }

// Walk EVERY campaign on an instance via cursor pagination (per_page is fixed
// at 15; cursor mode isn't capped at the offset 1000-page limit). Follows
// meta.next_cursor until null, with the single-element-array unwrap some Bison
// endpoints use. Each page GET retries transient failures via bisonGetWithRetry.
async function listCampaignsCursor(instance: BisonInstanceSlug): Promise<RawCampaign[]> {
  const all: RawCampaign[] = [];
  let cursor: string | null = null;
  let guard = 0;
  while (true) {
    if (guard++ > 5000) throw new Error(`campaigns cursor runaway (${instance})`);
    const qs = cursor
      ? `pagination_type=cursor&cursor=${encodeURIComponent(cursor)}`
      : `pagination_type=cursor`;
    const res = await bisonGetWithRetry(instance, `/campaigns?${qs}`);
    const json = await res.json();
    const payload = Array.isArray(json) ? json[0] : json;
    const data: RawCampaign[] = payload?.data || [];
    all.push(...data);
    const next: string | null = payload?.meta?.next_cursor ?? null;
    if (!next || data.length === 0) break;
    cursor = next;
  }
  return all;
}

async function nurtureDraftsForInstance(instance: BisonInstanceSlug): Promise<NurtureDraft[]> {
  const campaigns = await listCampaignsCursor(instance);
  const candidates = campaigns.filter((c) =>
    (c.name || "").toLowerCase().includes("[nurture]") &&
    (c.status || "").trim().toLowerCase() === "draft" &&
    (c.total_leads || 0) >= MIN_LEADS,
  );

  const out: NurtureDraft[] = [];
  for (let i = 0; i < candidates.length; i += SENDER_CONCURRENCY) {
    const batch = candidates.slice(i, i + SENDER_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (c) => {
        try {
          const ids = await fetchCampaignSenderEmails(instance, c.id);
          return { instance, id: c.id, name: c.name, leads: c.total_leads || 0, senders: ids.length } as NurtureDraft;
        } catch {
          return null; // sender count failed for this one — skip (refresh retries)
        }
      }),
    );
    for (const r of results) if (r && r.senders >= MIN_SENDERS) out.push(r);
  }
  return out;
}

export async function GET() {
  const results = await Promise.allSettled(ALL_INSTANCE_SLUGS.map((i) => nurtureDraftsForInstance(i)));
  const campaigns: NurtureDraft[] = [];
  const errors: { instance: string; error: string }[] = [];
  results.forEach((r, idx) => {
    const instance = ALL_INSTANCE_SLUGS[idx];
    if (r.status === "fulfilled") campaigns.push(...r.value);
    else errors.push({ instance, error: r.reason instanceof Error ? r.reason.message : "failed" });
  });
  campaigns.sort((a, b) => a.instance.localeCompare(b.instance) || a.name.localeCompare(b.name));
  return NextResponse.json({ campaigns, errors });
}
