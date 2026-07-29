// Post-reconnect worker: for every sender that reconnected in Bison, once its
// last-known tags have been re-attached (that part happens synchronously in
// the /api/webhooks/bison-reconnect webhook), we still need to
//
//   1. Conform the sender's tags against its domain's wanted-tag set
//      (deliverability_domains.tags is the source of truth). Bison drops all
//      tags on reconnect. The webhook restores the sender's LAST-KNOWN tags,
//      but if the domain's wanted set has since gained a tag, we need to add
//      it here.
//
//   2. Attach the sender to every campaign matching one of its client tags
//      (name-prefix match, e.g. sender tagged CCGSTL → attach to campaigns
//      whose name starts with "CCGSTL:"). Includes active/launching/queued
//      /paused campaigns; skips Draft/Completed/Archived.
//
// That work isn't done inline in the webhook — Vercel's 30s webhook budget
// isn't enough when a client has 50+ campaigns and each campaign attach hits
// Bison's rate limit. Instead the webhook enqueues into `pending_reconnect_work`
// and this worker drains the queue every 5 minutes with proper retry +
// concurrency control.

import { bisonFetch } from "@/lib/bison";
import { getSupabaseAdmin } from "@/lib/supabase";
import { isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";
import { getOffboardedClientTags, isOffboardedTagName } from "@/lib/offboarded-tags";

// Campaign statuses we RE-ATTACH the sender to on reconnect. Matches the
// user's "include Paused" pick — a paused-on-purpose campaign should still
// have the sender ready when it resumes. Draft/Completed/Archived stay out.
const REATTACH_STATUSES = new Set(["active", "launching", "queued", "paused"]);

interface PendingRow {
  id: number;
  instance: BisonInstanceSlug;
  sender_id: number;
  sender_email: string | null;
  attempts: number;
}

interface InboxRow {
  id: number;
  instance: BisonInstanceSlug;
  email: string | null;
  domain: string | null;
  tags: { id?: number; name?: string }[] | null;
}

interface DomainRow {
  domain: string;
  tags: string[] | null;
}

interface CampaignRow {
  id: number;
  instance: BisonInstanceSlug;
  name: string;
  status: string;
  client_tag: string;
}

interface BisonTag { id: number; name: string }

// Retry Bison writes on transient 429/5xx with jittered backoff. Non-transient
// failures (400/404/422) return immediately so the caller can classify them
// (e.g. 404 means the sender is gone in Bison — stop trying).
async function bisonWriteWithRetry(
  instance: BisonInstanceSlug,
  path: string,
  method: "POST" | "PATCH",
  body: unknown,
  attempts = 4,
): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i < attempts; i++) {
    const res = await bisonFetch(instance, path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return res;
    if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
      last = res;
      const ra = parseInt(res.headers.get("retry-after") || "", 10);
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(8000, 500 * 2 ** i);
      await new Promise((r) => setTimeout(r, wait + Math.floor(Math.random() * 300)));
      continue;
    }
    return res;
  }
  return last as Response;
}

async function bisonGetWithRetry(
  instance: BisonInstanceSlug,
  path: string,
  attempts = 4,
): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i < attempts; i++) {
    const res = await bisonFetch(instance, path);
    if (res.ok) return res;
    if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
      last = res;
      const ra = parseInt(res.headers.get("retry-after") || "", 10);
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(8000, 500 * 2 ** i);
      await new Promise((r) => setTimeout(r, wait + Math.floor(Math.random() * 300)));
      continue;
    }
    return res;
  }
  return last as Response;
}

export interface ProcessRowResult {
  ok: boolean;
  tagsAttached: number;
  campaignsAttached: number;
  campaignsSkipped: number;
  error?: string;
  fatal?: boolean; // e.g. 404 sender gone — don't retry
}

/**
 * Enqueue a sender for post-reconnect processing. Safe to call from the
 * webhook — upserts on (instance, sender_id) so a Bison retry / duplicate
 * event re-queues the same row rather than duplicating.
 */
export async function enqueueReconnect(entry: {
  instance: BisonInstanceSlug;
  senderId: number;
  senderEmail: string | null;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("pending_reconnect_work").upsert(
    {
      instance: entry.instance,
      sender_id: entry.senderId,
      sender_email: entry.senderEmail,
      enqueued_at: new Date().toISOString(),
      status: "pending",
      attempts: 0,
      last_error: null,
      processed_at: null,
      result: null,
    },
    { onConflict: "instance,sender_id" },
  );
  if (error) {
    // Soft-log — this is best-effort. The daily disconnect/reconnect report
    // will still show the reconnect via reconnect_tag_log; we just miss the
    // conform+attach pass. Table probably doesn't exist yet: paste
    // supabase/pending-reconnect-work.sql into Supabase.
    console.warn(`[reconnect-worker] enqueue failed (${entry.instance}/${entry.senderId}): ${error.message}`);
  }
}

/** Handle one queue row end-to-end. */
async function processRow(row: PendingRow): Promise<ProcessRowResult> {
  const supabase = getSupabaseAdmin();

  // 1. Get the sender's cached record (domain + last-known tags). If the
  //    sender isn't in our cache yet we can't drive the domain lookup —
  //    treat as skipped (transient — the next sync-deliverability cron will
  //    bring it in).
  const { data: inbox, error: inboxErr } = await supabase
    .from("deliverability_inboxes")
    .select("id, instance, email, domain, tags")
    .eq("instance", row.instance)
    .eq("id", row.sender_id)
    .maybeSingle();
  if (inboxErr) {
    return { ok: false, tagsAttached: 0, campaignsAttached: 0, campaignsSkipped: 0, error: `inbox lookup: ${inboxErr.message}` };
  }
  if (!inbox) {
    // No cache row → not synced yet. Retry later; don't mark fatal.
    return { ok: false, tagsAttached: 0, campaignsAttached: 0, campaignsSkipped: 0, error: "sender not in deliverability_inboxes yet" };
  }
  const inboxRow = inbox as InboxRow;
  const domain = (inboxRow.domain || "").toLowerCase();

  // 2. Conform tags: diff sender's current tags against the domain's wanted
  //    set. Use uppercase for comparison (canonical form).
  const senderTagNames = new Set<string>(
    (inboxRow.tags || []).map((t) => (t?.name || "").trim().toUpperCase()).filter(Boolean),
  );

  const wantedTagNames = new Set<string>();
  if (domain) {
    const { data: dRow } = await supabase
      .from("deliverability_domains")
      .select("domain, tags")
      .eq("instance", row.instance)
      .eq("domain", domain)
      .maybeSingle();
    const domainRow = dRow as DomainRow | null;
    if (domainRow && Array.isArray(domainRow.tags)) {
      // churned clients' tags are never wanted — don't resurrect on reconnect
      const offboarded = await getOffboardedClientTags();
      for (const t of domainRow.tags) {
        const u = (t || "").trim().toUpperCase();
        if (u && !isOffboardedTagName(u, offboarded)) wantedTagNames.add(u);
      }
    }
  }
  const missingTagNames: string[] = [];
  for (const w of wantedTagNames) if (!senderTagNames.has(w)) missingTagNames.push(w);

  // Fetch Bison's tag list once so we can resolve names → IDs (and create
  // any that don't exist yet on this instance).
  let bisonTagsByUpper = new Map<string, BisonTag>();
  const needsBisonTags = missingTagNames.length > 0 || senderTagNames.size > 0;
  if (needsBisonTags) {
    const tagsRes = await bisonGetWithRetry(row.instance, `/tags`);
    if (!tagsRes.ok) {
      return { ok: false, tagsAttached: 0, campaignsAttached: 0, campaignsSkipped: 0, error: `list tags: ${tagsRes.status}` };
    }
    const tagsJson = await tagsRes.json();
    const currentTags: BisonTag[] = tagsJson.data || [];
    bisonTagsByUpper = new Map(currentTags.map((t) => [t.name.toUpperCase(), t]));
  }

  // Attach missing tags. Create any that don't exist yet on this instance.
  let tagsAttached = 0;
  const resolvedMissingIds: number[] = [];
  for (const nameU of missingTagNames) {
    let resolved = bisonTagsByUpper.get(nameU);
    if (!resolved) {
      const createRes = await bisonWriteWithRetry(row.instance, `/tags`, "POST", { name: nameU });
      if (createRes.ok) {
        const created = await createRes.json();
        const newTag: BisonTag = created.data || created;
        if (newTag?.id) {
          resolved = newTag;
          bisonTagsByUpper.set(nameU, newTag);
        }
      }
      if (!resolved) continue; // couldn't resolve; skip this tag, keep going
    }
    resolvedMissingIds.push(resolved.id);
  }
  if (resolvedMissingIds.length > 0) {
    const attachTagsRes = await bisonWriteWithRetry(
      row.instance,
      `/tags/attach-to-sender-emails`,
      "POST",
      { tag_ids: resolvedMissingIds, sender_email_ids: [row.sender_id] },
    );
    if (attachTagsRes.ok) {
      tagsAttached = resolvedMissingIds.length;
    } else if (attachTagsRes.status === 404) {
      // Sender is gone in Bison — stop retrying this row.
      return {
        ok: false, tagsAttached: 0, campaignsAttached: 0, campaignsSkipped: 0,
        error: `attach tags: 404 sender not found in Bison`, fatal: true,
      };
    } else {
      const txt = await attachTagsRes.text().catch(() => "");
      return {
        ok: false, tagsAttached: 0, campaignsAttached: 0, campaignsSkipped: 0,
        error: `attach tags: ${attachTagsRes.status} ${txt.slice(0, 150)}`,
      };
    }
  }

  // Build the set of tag NAMES this sender will have after the conform step.
  // We use this to determine which campaigns to attach the sender to.
  const finalTagNamesUpper = new Set<string>(senderTagNames);
  for (const nameU of missingTagNames) finalTagNamesUpper.add(nameU);

  // 3. Attach to campaigns: for each client tag on this sender, find
  //    campaigns whose client_tag matches and whose status is one we
  //    consider "re-attachable" (active/launching/queued/paused). Attach
  //    the sender to each one. Bison's attach endpoint is idempotent, so
  //    duplicates are silently ignored.
  let campaignsAttached = 0;
  let campaignsSkipped = 0;
  // never re-attach to a CHURNED client's campaigns (they're being offboarded)
  const offboardedForAttach = await getOffboardedClientTags();
  const attachableTags = [...finalTagNamesUpper].filter((t) => !isOffboardedTagName(t, offboardedForAttach));
  if (attachableTags.length > 0) {
    const clientTagsUpper = attachableTags;
    // Case-insensitive: the campaigns table stores client_tag verbatim, so
    // fetch and filter in JS.
    const { data: campaignRows, error: campErr } = await supabase
      .from("campaigns")
      .select("id, instance, name, status, client_tag")
      .eq("instance", row.instance)
      .in("client_tag", clientTagsUpper); // client_tag is UPPER-derived from the name prefix
    if (campErr) {
      return {
        ok: false, tagsAttached, campaignsAttached: 0, campaignsSkipped: 0,
        error: `campaigns query: ${campErr.message}`,
      };
    }
    const campaigns = ((campaignRows || []) as CampaignRow[]).filter((c) =>
      REATTACH_STATUSES.has((c.status || "").trim().toLowerCase()),
    );
    for (const c of campaigns) {
      const attachRes = await bisonWriteWithRetry(
        row.instance,
        `/campaigns/${c.id}/attach-sender-emails`,
        "POST",
        { sender_email_ids: [row.sender_id] },
      );
      if (attachRes.ok) {
        campaignsAttached++;
      } else if (attachRes.status === 404) {
        // Campaign gone in Bison but our row is stale — skip and continue.
        campaignsSkipped++;
      } else {
        // Non-fatal but flag it. We treat one bad campaign as retryable.
        const txt = await attachRes.text().catch(() => "");
        console.warn(
          `[reconnect-worker:${row.instance}] sender ${row.sender_id} → campaign ${c.id}: ${attachRes.status} ${txt.slice(0, 120)}`,
        );
        campaignsSkipped++;
      }
    }
  }

  return { ok: true, tagsAttached, campaignsAttached, campaignsSkipped };
}

interface WorkerRunResult {
  processed: number;
  succeeded: number;
  failed: number;
  fatal: number;
  totalTagsAttached: number;
  totalCampaignsAttached: number;
  durationMs: number;
}

const MAX_ATTEMPTS = 5;

/**
 * Drains up to `limit` pending rows. Runs one row at a time per instance
 * (Bison rate-limits per instance; sequential is safer than trying to fan
 * out). Different instances run concurrently — each has its own rate bucket.
 * Bounded by `deadlineMs`.
 */
export async function runReconnectWorker(opts: {
  limit?: number;
  deadlineMs?: number;
} = {}): Promise<WorkerRunResult> {
  const startMs = Date.now();
  const deadlineMs = opts.deadlineMs ?? 55_000; // leave headroom under 60s
  const limit = opts.limit ?? 200;
  const supabase = getSupabaseAdmin();

  const { data: pendingRaw, error: readErr } = await supabase
    .from("pending_reconnect_work")
    .select("id, instance, sender_id, sender_email, attempts")
    .eq("status", "pending")
    .lt("attempts", MAX_ATTEMPTS)
    .order("enqueued_at", { ascending: true })
    .limit(limit);
  if (readErr) throw new Error(`pending_reconnect_work read: ${readErr.message}`);

  const rows: PendingRow[] = ((pendingRaw || []) as Array<{
    id: number; instance: string; sender_id: number; sender_email: string | null; attempts: number;
  }>)
    .filter((r) => isInstanceSlug(r.instance))
    .map((r) => ({
      id: r.id,
      instance: r.instance as BisonInstanceSlug,
      sender_id: r.sender_id,
      sender_email: r.sender_email,
      attempts: r.attempts,
    }));

  const byInstance = new Map<BisonInstanceSlug, PendingRow[]>();
  for (const r of rows) {
    let arr = byInstance.get(r.instance);
    if (!arr) { arr = []; byInstance.set(r.instance, arr); }
    arr.push(r);
  }

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let fatal = 0;
  let totalTagsAttached = 0;
  let totalCampaignsAttached = 0;

  const runQueueForInstance = async (queue: PendingRow[]) => {
    for (const row of queue) {
      if (Date.now() - startMs >= deadlineMs) return;
      // Mark processing (best-effort — if this fails, we still attempt and update at the end).
      await supabase
        .from("pending_reconnect_work")
        .update({ status: "processing", attempts: row.attempts + 1 })
        .eq("id", row.id);
      let result: ProcessRowResult;
      try {
        result = await processRow(row);
      } catch (e) {
        result = {
          ok: false, tagsAttached: 0, campaignsAttached: 0, campaignsSkipped: 0,
          error: e instanceof Error ? e.message : "processor threw",
        };
      }
      processed++;
      if (result.ok) {
        succeeded++;
        totalTagsAttached += result.tagsAttached;
        totalCampaignsAttached += result.campaignsAttached;
        await supabase
          .from("pending_reconnect_work")
          .update({
            status: "done",
            processed_at: new Date().toISOString(),
            last_error: null,
            result: {
              tagsAttached: result.tagsAttached,
              campaignsAttached: result.campaignsAttached,
              campaignsSkipped: result.campaignsSkipped,
            },
          })
          .eq("id", row.id);
      } else if (result.fatal) {
        fatal++;
        await supabase
          .from("pending_reconnect_work")
          .update({
            status: "failed",
            processed_at: new Date().toISOString(),
            last_error: result.error ?? "fatal",
          })
          .eq("id", row.id);
      } else {
        failed++;
        // Non-fatal → back to pending for the next run, unless we've hit
        // MAX_ATTEMPTS in which case it's classified as failed.
        const willRetry = row.attempts + 1 < MAX_ATTEMPTS;
        await supabase
          .from("pending_reconnect_work")
          .update({
            status: willRetry ? "pending" : "failed",
            processed_at: willRetry ? null : new Date().toISOString(),
            last_error: result.error ?? "unknown",
          })
          .eq("id", row.id);
      }
    }
  };

  await Promise.all([...byInstance.values()].map(runQueueForInstance));

  return {
    processed,
    succeeded,
    failed,
    fatal,
    totalTagsAttached,
    totalCampaignsAttached,
    durationMs: Date.now() - startMs,
  };
}
