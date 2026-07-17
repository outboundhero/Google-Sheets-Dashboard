import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch, resolveInstance } from "@/lib/bison";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Fail {
  id: number;
  reason: string;
  // retryable = a transient/rate-limit error worth re-running; not a permanently
  // bad/disconnected inbox. Drives the "Retry skipped" button in the UI.
  retryable: boolean;
}

// Turn a Bison non-OK response into a human reason so the UI can explain WHY an
// inbox was skipped (Spencer's ask) instead of just "N skipped".
function classifyReason(status: number, body: string): string {
  if (status === 429) return "Rate limited by Bison — retryable";
  if (status >= 500) return `Bison server error (${status}) — retryable`;
  if (status === 0) return `Network error — retryable${body ? `: ${body.slice(0, 60)}` : ""}`;
  let msg = body;
  try {
    const j = JSON.parse(body);
    msg = j.message || j.error || body;
  } catch { /* keep raw body */ }
  // The overwhelmingly common 4xx case is a disconnected / removed sender email.
  if (!msg) return `Rejected by Bison (${status}) — likely disconnected`;
  return msg.slice(0, 140);
}

// Attach a set of sender-email IDs to a campaign, isolating exactly which ones
// fail and why. Transient failures (429 rate-limit / 5xx / network) are retried
// with exponential backoff and, if still failing, reported as retryable WITHOUT
// splitting (a rate-limit isn't a bad-ID problem). Permanent 4xx failures are
// bisected down to the individual offending IDs so good inboxes still attach.
async function attachIds(
  instance: BisonInstanceSlug,
  campaignId: number,
  ids: number[],
): Promise<{ attached: number; fails: Fail[] }> {
  if (ids.length === 0) return { attached: 0, fails: [] };

  let status = 0;
  let body = "";
  let transient = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await bisonFetch(instance, `/campaigns/${campaignId}/attach-sender-emails`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender_email_ids: ids }),
      });
      if (res.ok) return { attached: ids.length, fails: [] };
      status = res.status;
      body = await res.text().catch(() => "");
    } catch (e) {
      status = 0;
      body = e instanceof Error ? e.message : "network error";
    }
    transient = status === 429 || status >= 500 || status === 0;
    if (transient && attempt < 3) {
      await delay(800 * 2 ** attempt); // 0.8s, 1.6s, 3.2s
      continue;
    }
    break;
  }

  // Still failing on a transient error → retryable, don't bisect (rate-limit
  // affects the whole batch equally; splitting just multiplies the calls).
  if (transient) {
    const reason = classifyReason(status, body);
    return { attached: 0, fails: ids.map((id) => ({ id, reason, retryable: true })) };
  }

  // Permanent failure. One ID → terminal; many → bisect to find the bad ones.
  if (ids.length === 1) {
    return { attached: 0, fails: [{ id: ids[0], reason: classifyReason(status, body), retryable: false }] };
  }
  const mid = Math.floor(ids.length / 2);
  const left = await attachIds(instance, campaignId, ids.slice(0, mid));
  await delay(120);
  const right = await attachIds(instance, campaignId, ids.slice(mid));
  return { attached: left.attached + right.attached, fails: [...left.fails, ...right.fails] };
}

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const instance = resolveInstance(searchParams.get("instance"));
    const body = (await request.json()) as {
      campaign_id: number;
      domains?: string[];
      // Surgical retry: attach exactly these sender-email IDs (skips the
      // domain→inbox resolution entirely). Used to re-attempt only the inboxes
      // that failed on a prior run instead of re-walking every domain.
      sender_email_ids?: number[];
    };
    const campaign_id = body.campaign_id;
    const domains = body.domains || [];
    const explicitIds = Array.isArray(body.sender_email_ids)
      ? body.sender_email_ids.filter((n) => Number.isFinite(n))
      : null;

    if (!campaign_id || (!explicitIds?.length && !domains.length)) {
      return NextResponse.json({ error: "campaign_id and (domains or sender_email_ids) required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();

    // 1. Inbox IDs to consider: explicit list (surgical retry) OR resolved from
    // the selected domains (paginate past the 1000-row limit, scoped to this
    // instance). Keep email/domain per id so skipped inboxes can be named.
    const allInboxIds: number[] = [];
    const inboxMeta = new Map<number, { email: string; domain: string }>();
    if (explicitIds?.length) {
      allInboxIds.push(...explicitIds);
    } else {
      for (let i = 0; i < domains.length; i += 20) {
        const batch = domains.slice(i, i + 20);
        let offset = 0;
        while (true) {
          const { data } = await supabase
            .from("deliverability_inboxes")
            .select("id, email, domain")
            .eq("instance", instance)
            .in("domain", batch)
            .range(offset, offset + 999);
          if (!data || data.length === 0) break;
          for (const d of data) {
            allInboxIds.push(d.id);
            inboxMeta.set(d.id, { email: d.email ?? "", domain: d.domain ?? "" });
          }
          if (data.length < 1000) break;
          offset += 1000;
        }
      }
    }

    console.log(`[ATTACH-DOMAIN:${instance}] Campaign ${campaign_id}: found ${allInboxIds.length} inboxes across ${domains.length} domains`);

    if (allInboxIds.length === 0) {
      return NextResponse.json({ total_matched: 0, already_attached: 0, newly_attached: 0 });
    }

    // 2. Get already-attached sender emails for this campaign
    const alreadyAttached = new Set<number>();
    let page = 1;
    while (true) {
      const res = await bisonFetch(
        instance,
        `/campaigns/${campaign_id}/sender-emails?page=${page}&per_page=100`,
      );
      if (!res.ok) break;
      const json = await res.json();
      const data = json.data || [];
      for (const item of data) alreadyAttached.add(item.id);
      const lastPage = json.meta?.last_page || 1;
      if (page >= lastPage) break;
      page++;
    }

    // 3. Filter out already-attached
    const newIds = allInboxIds.filter((id) => !alreadyAttached.has(id));
    const alreadyCount = allInboxIds.length - newIds.length;

    // 4. Attach in batches of 50. attachIds() retries transient errors with
    //    backoff and bisects permanent ones, returning per-inbox reasons.
    let attached = 0;
    const fails: Fail[] = [];
    const ATTACH_BATCH = 50;
    for (let i = 0; i < newIds.length; i += ATTACH_BATCH) {
      const batch = newIds.slice(i, i + ATTACH_BATCH);
      const r = await attachIds(instance, campaign_id, batch);
      attached += r.attached;
      fails.push(...r.fails);
      if (i + ATTACH_BATCH < newIds.length) await delay(300);
    }

    const failedInboxes = fails.map((f) => ({
      id: f.id, // sender-email ID — lets the client retry ONLY these
      email: inboxMeta.get(f.id)?.email || String(f.id),
      domain: inboxMeta.get(f.id)?.domain || "",
      reason: f.reason,
      retryable: f.retryable,
    }));
    const rateLimited = fails.filter((f) => f.retryable).length;
    if (fails.length > 0) {
      console.warn(`[ATTACH-DOMAIN:${instance}] Campaign ${campaign_id}: ${attached} attached, ${fails.length} skipped (${rateLimited} retryable)`);
    }

    return NextResponse.json({
      total_matched: allInboxIds.length,
      already_attached: alreadyCount,
      newly_attached: attached,
      failed: fails.length,
      rateLimited,         // subset of failed that were transient/rate-limit → worth retrying
      failedInboxes,       // [{ email, domain, reason, retryable }] — explains WHY each was skipped
      instance,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
