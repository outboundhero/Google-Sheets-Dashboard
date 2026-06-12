import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

// One-shot orchestration: find every nurture campaign in outboundhero, find
// inboxes in outboundhero tagged with the campaign's client tag, attach them.
// GET ?dryRun=1 → preview only, no Bison writes. GET ?dryRun=0 (or absent
// `dryRun` on POST) → actually attach.

export const maxDuration = 60;

const INSTANCE: BisonInstanceSlug = "outboundhero";
const BATCH = 50;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface InboxRow { id: number; email: string }
interface CampaignReport {
  id: number;
  name: string;
  status: string | null;
  clientTag: string;
  inboxesMatched: number;
  newlyAttached: number;
  alreadyAttached: number;
  failed: number;
  error: string | null;
  skipped: string | null;
  dryRun: boolean;
}

async function findCampaigns() {
  const supabase = getSupabaseAdmin();
  // ILIKE %nurture% — covers "Nurture", "nurture campaign", "JPCO: Nurture", etc.
  const { data, error } = await supabase
    .from("campaigns")
    .select("id, name, client_tag, status")
    .eq("instance", INSTANCE)
    .ilike("name", "%nurture%")
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function findInboxesForTag(tag: string): Promise<InboxRow[]> {
  const supabase = getSupabaseAdmin();
  const out: InboxRow[] = [];
  let offset = 0;
  // Tags column is jsonb array of {id, name}. `contains` matches any element
  // having { name: tag }. Paginate to clear the 1000-row default cap.
  while (true) {
    const { data, error } = await supabase
      .from("deliverability_inboxes")
      .select("id, email")
      .eq("instance", INSTANCE)
      .contains("tags", [{ name: tag }])
      .range(offset, offset + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    out.push(...(data as InboxRow[]));
    if (data.length < 1000) break;
    offset += 1000;
  }
  return out;
}

interface AttachOutcome {
  newly: number;
  already: number;
  failed: number;
  errorMsg: string | null;
}

// Attach inbox IDs to one campaign, mirroring the batch + 422 sub-batch + single
// fallback the existing attach-domains-to-campaign route uses.
async function attachToCampaign(campaignId: number, inboxIds: number[]): Promise<AttachOutcome> {
  let newly = 0;
  let already = 0;
  let failed = 0;
  let errorMsg: string | null = null;

  for (let i = 0; i < inboxIds.length; i += BATCH) {
    const batch = inboxIds.slice(i, i + BATCH);
    try {
      const res = await bisonFetch(INSTANCE, `/campaigns/${campaignId}/attach-sender-emails`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender_email_ids: batch }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        newly += Number(data.newly_attached || 0);
        already += Number(data.already_attached || 0);
      } else if (res.status === 422) {
        // Drop to sub-batches of 10 to isolate bad IDs.
        for (let j = 0; j < batch.length; j += 10) {
          const sub = batch.slice(j, j + 10);
          try {
            const subRes = await bisonFetch(INSTANCE, `/campaigns/${campaignId}/attach-sender-emails`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sender_email_ids: sub }),
            });
            if (subRes.ok) {
              const d = await subRes.json().catch(() => ({}));
              newly += Number(d.newly_attached || 0);
              already += Number(d.already_attached || 0);
            } else {
              // One at a time as a last resort.
              for (const id of sub) {
                try {
                  const sr = await bisonFetch(INSTANCE, `/campaigns/${campaignId}/attach-sender-emails`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ sender_email_ids: [id] }),
                  });
                  if (sr.ok) {
                    const d = await sr.json().catch(() => ({}));
                    newly += Number(d.newly_attached || 0);
                    already += Number(d.already_attached || 0);
                  } else {
                    failed++;
                  }
                } catch {
                  failed++;
                }
              }
            }
          } catch {
            failed += sub.length;
          }
          await delay(150);
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
    if (i + BATCH < inboxIds.length) await delay(250);
  }

  return { newly, already, failed, errorMsg };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const dryRun = searchParams.get("dryRun") !== "0";

    const campaigns = await findCampaigns();
    const reports: CampaignReport[] = [];

    for (const c of campaigns) {
      const tag = (c.client_tag as string | null)?.trim() || "";
      const base: CampaignReport = {
        id: c.id as number,
        name: c.name as string,
        status: (c.status as string | null) ?? null,
        clientTag: tag,
        inboxesMatched: 0,
        newlyAttached: 0,
        alreadyAttached: 0,
        failed: 0,
        error: null,
        skipped: null,
        dryRun,
      };

      if (!tag) {
        base.skipped = "campaign name has no client tag prefix (no ':') — can't determine tag";
        reports.push(base);
        continue;
      }

      let inboxes: InboxRow[] = [];
      try {
        inboxes = await findInboxesForTag(tag);
      } catch (e) {
        base.error = `find inboxes failed: ${e instanceof Error ? e.message : "unknown"}`;
        reports.push(base);
        continue;
      }

      base.inboxesMatched = inboxes.length;
      if (inboxes.length === 0) {
        base.skipped = `no inboxes in outboundhero tagged "${tag}"`;
        reports.push(base);
        continue;
      }

      if (dryRun) {
        reports.push(base);
        continue;
      }

      const ids = inboxes.map((i) => i.id);
      const outcome = await attachToCampaign(c.id as number, ids);
      base.newlyAttached = outcome.newly;
      base.alreadyAttached = outcome.already;
      base.failed = outcome.failed;
      base.error = outcome.errorMsg;
      reports.push(base);
    }

    const totals = {
      campaigns: reports.length,
      campaignsActionable: reports.filter((r) => !r.skipped).length,
      inboxesMatched: reports.reduce((s, r) => s + r.inboxesMatched, 0),
      newlyAttached: reports.reduce((s, r) => s + r.newlyAttached, 0),
      alreadyAttached: reports.reduce((s, r) => s + r.alreadyAttached, 0),
      failed: reports.reduce((s, r) => s + r.failed, 0),
    };

    return NextResponse.json({
      instance: INSTANCE,
      dryRun,
      totals,
      campaigns: reports,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
