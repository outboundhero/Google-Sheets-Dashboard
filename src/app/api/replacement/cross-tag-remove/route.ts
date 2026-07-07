import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import { isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";
import { fetchCampaignSenderEmails } from "@/lib/attach-campaigns";

export const maxDuration = 300;

/**
 * POST /api/replacement/cross-tag-remove  (v4 — spec-informed)
 *
 * Campaign-centric removal for the cross-tag audit. Two facts from Bison's
 * OpenAPI spec drive this design:
 *
 *   1. DELETE /campaigns/{id}/remove-sender-emails only works on a DRAFT or
 *      PAUSED campaign ("allows the authenticated user to remove sender
 *      emails from a draft or paused campaign"). So we check the campaign's
 *      LIVE status first (stored audit status can be stale) and pause any
 *      sendable campaign before removing — that was the systematic failure
 *      in v3, which only paused when the stale stored status said "active".
 *
 *   2. The endpoint is an ASYNC QUEUE ("Sender emails sent for deletion.
 *      This may take a moment") with no documented array cap — so we submit
 *      the candidate inbox IDs BLIND in large batches and let Bison's queue
 *      detach whatever is actually attached. No sender-list fetching: the
 *      big nurture campaigns hold 10-15K senders at a hard 15/page cap
 *      (~1,000 pages per campaign), which is what made v3 crawl.
 *
 * Campaigns that are ARCHIVED or COMPLETED are skipped as success — they
 * can't send, so contamination in them is inert (and the audit no longer
 * flags them).
 *
 * Second action — { action: "clearDomains", domains: [...] } bulk-deletes
 * cleaned rows from cross_tag_audit.
 *
 * Admin-only via middleware.
 */

interface CampaignJob {
  instance: string;
  id: number;
  name?: string;
  status?: string;
  domains: string[];
}

interface JobResult {
  instance: string;
  campaignId: number;
  name: string;
  ok: boolean;
  removed: number;   // candidate ids submitted for deletion (async queue)
  note?: string;
  error?: string;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CAMPAIGN_CONC = 10;      // campaign jobs in flight — each holds at most
                               // one Bison call at a time, well under the
                               // ~20-25 sustained per-instance ceiling
const DELETE_BATCH = 2000;     // async queue endpoint; downshifts on 4xx

// States that cannot send — contamination in them is inert, skip.
const INERT_STATUSES = new Set(["archived", "completed"]);
// States where removal works directly without pausing.
const REMOVABLE_STATUSES = new Set(["draft", "paused"]);

async function bisonWithRetry(
  instance: BisonInstanceSlug,
  path: string,
  init?: RequestInit,
  attempts = 6,
): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i < attempts; i++) {
    const res = await bisonFetch(instance, path, init);
    if (res.ok) return res;
    // 500 included: Bison intermittently 500s under load.
    if (res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504) {
      last = res;
      const ra = parseInt(res.headers.get("retry-after") || "", 10);
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(15_000, 600 * 2 ** i);
      await delay(wait + Math.floor(Math.random() * 400));
      continue;
    }
    return res;
  }
  return last as Response;
}

async function pool<T>(items: T[], conc: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, () => worker()));
}

/** Live campaign status — the stored audit status can be stale, and removal
 *  semantics depend on the CURRENT state. Returns null when the campaign is
 *  gone (404). */
async function fetchLiveStatus(instance: BisonInstanceSlug, campaignId: number): Promise<string | null> {
  const res = await bisonWithRetry(instance, `/campaigns/${campaignId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`campaign status: HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { status?: string }; status?: string };
  return String(json.data?.status ?? json.status ?? "").trim().toLowerCase();
}

/** Bulk inbox-ID map for a set of domains on one instance (memoized per request). */
async function loadInboxIds(
  instance: BisonInstanceSlug,
  domains: string[],
  cache: Map<string, number[]>,
): Promise<void> {
  const missing = domains.filter((d) => !cache.has(`${instance}:${d}`));
  if (missing.length === 0) return;
  const supabase = getSupabaseAdmin();
  for (const d of missing) cache.set(`${instance}:${d}`, []);
  for (let i = 0; i < missing.length; i += 50) {
    const batch = missing.slice(i, i + 50);
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from("deliverability_inboxes")
        .select("id, domain")
        .eq("instance", instance)
        .in("domain", batch)
        .range(offset, offset + 999);
      if (error) throw new Error(`inbox read: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const r of data as { id: number; domain: string }[]) {
        cache.get(`${instance}:${r.domain}`)!.push(r.id);
      }
      if (data.length < 1000) break;
      offset += 1000;
    }
  }
}

/** Submit candidate ids for deletion, blind, in large batches. Downshifts
 *  batch size on 4xx; falls back to exact intersect-removal if even small
 *  blind batches are rejected. Returns ids submitted. */
async function removeCandidates(
  instance: BisonInstanceSlug,
  campaignId: number,
  candidates: number[],
  candidateSet: Set<number>,
): Promise<number> {
  let batchSize = DELETE_BATCH;
  let submitted = 0;
  let i = 0;
  while (i < candidates.length) {
    const batch = candidates.slice(i, i + batchSize);
    const res = await bisonWithRetry(instance, `/campaigns/${campaignId}/remove-sender-emails`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender_email_ids: batch }),
    });
    if (res.ok) {
      submitted += batch.length;
      i += batchSize;
      continue;
    }
    if (res.status === 404) return submitted; // campaign vanished mid-run
    if ((res.status === 400 || res.status === 413 || res.status === 422) && batchSize > 100) {
      batchSize = batchSize > 500 ? 500 : 100; // payload too big → downshift
      continue;
    }
    if (res.status === 422) {
      // Even small blind batches rejected → this Bison build wants exact
      // membership. Fall back once: cursor-walk actual senders, intersect.
      const actual = await fetchCampaignSenderEmails(instance, campaignId);
      const toRemove = actual.filter((id) => candidateSet.has(id));
      let exact = 0;
      for (let j = 0; j < toRemove.length; j += 100) {
        const b2 = toRemove.slice(j, j + 100);
        const r2 = await bisonWithRetry(instance, `/campaigns/${campaignId}/remove-sender-emails`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sender_email_ids: b2 }),
        });
        if (!r2.ok) {
          const t = await r2.text().catch(() => "");
          throw new Error(`exact remove: ${r2.status} ${t.slice(0, 120)}`);
        }
        exact += b2.length;
      }
      return exact;
    }
    const t = await res.text().catch(() => "");
    throw new Error(`remove batch at ${i}: ${res.status} ${t.slice(0, 120)}`);
  }
  return submitted;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    // ── Action: bulk-clear cleaned domains from the audit table ──────────
    if (body?.action === "clearDomains") {
      const domains = (body.domains || []) as { instance: string; domain: string }[];
      const supabase = getSupabaseAdmin();
      let cleared = 0;
      const byInstance = new Map<string, string[]>();
      for (const d of domains) {
        if (!isInstanceSlug(d.instance) || !d.domain) continue;
        const arr = byInstance.get(d.instance) || [];
        arr.push(d.domain);
        byInstance.set(d.instance, arr);
      }
      for (const [instance, doms] of byInstance) {
        for (let i = 0; i < doms.length; i += 100) {
          const batch = doms.slice(i, i + 100);
          const { error } = await supabase
            .from("cross_tag_audit")
            .delete()
            .eq("instance", instance)
            .in("domain", batch);
          if (!error) cleared += batch.length;
        }
      }
      return NextResponse.json({ cleared });
    }

    // ── Action: process a batch of campaign jobs ──────────────────────────
    const jobs = (body?.campaigns || []) as CampaignJob[];
    if (!Array.isArray(jobs) || jobs.length === 0) {
      return NextResponse.json({ error: "campaigns required" }, { status: 400 });
    }

    // Pre-resolve inbox IDs for every involved domain (bulk, memoized).
    const inboxCache = new Map<string, number[]>();
    const domainsByInstance = new Map<BisonInstanceSlug, Set<string>>();
    for (const j of jobs) {
      if (!isInstanceSlug(j.instance)) continue;
      const set = domainsByInstance.get(j.instance) || new Set<string>();
      for (const d of j.domains || []) set.add(d);
      domainsByInstance.set(j.instance, set);
    }
    await Promise.all(
      [...domainsByInstance.entries()].map(([inst, doms]) => loadInboxIds(inst, [...doms], inboxCache)),
    );

    const results: JobResult[] = [];
    await pool(jobs, CAMPAIGN_CONC, async (job) => {
      if (!isInstanceSlug(job.instance)) {
        results.push({ instance: job.instance, campaignId: job.id, name: job.name || `Campaign ${job.id}`, ok: false, removed: 0, error: `unknown instance ${job.instance}` });
        return;
      }
      const instance = job.instance;
      const name = job.name || `Campaign ${job.id}`;

      const candidateSet = new Set<number>();
      for (const d of job.domains || []) {
        for (const id of inboxCache.get(`${instance}:${d}`) || []) candidateSet.add(id);
      }
      const candidates = [...candidateSet];
      if (candidates.length === 0) {
        results.push({ instance, campaignId: job.id, name, ok: true, removed: 0, note: "no inboxes resolved" });
        return;
      }

      let pausedByUs = false;
      let liveStatus: string | null = null;
      try {
        // Removal only works on draft/paused campaigns — check the LIVE state.
        liveStatus = await fetchLiveStatus(instance, job.id);
        if (liveStatus === null) {
          results.push({ instance, campaignId: job.id, name, ok: true, removed: 0, note: "campaign gone in Bison" });
          return;
        }
        if (INERT_STATUSES.has(liveStatus)) {
          // Archived / completed can't send — contamination is inert.
          results.push({ instance, campaignId: job.id, name, ok: true, removed: 0, note: `skipped (${liveStatus} — cannot send)` });
          return;
        }
        let pauseError: string | null = null;
        if (!REMOVABLE_STATUSES.has(liveStatus)) {
          // active / launching / queued / anything else → try to pause first.
          // Some states (e.g. "failed", "stopped") reject the pause call but
          // still accept removal — so a failed pause is NOT fatal: we attempt
          // the removal regardless and only report the pause error if the
          // removal also fails.
          const p = await bisonWithRetry(instance, `/campaigns/${job.id}/pause`, { method: "PATCH" });
          if (p.ok) {
            pausedByUs = true;
            await delay(300);
          } else {
            const t = await p.text().catch(() => "");
            pauseError = `pause (status ${liveStatus}): HTTP ${p.status} ${t.slice(0, 120)}`;
          }
        }

        try {
          const removed = await removeCandidates(instance, job.id, candidates, candidateSet);
          results.push({ instance, campaignId: job.id, name, ok: true, removed });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "remove failed";
          throw new Error(pauseError ? `${pauseError} → then ${msg}` : msg);
        }
      } catch (e) {
        results.push({
          instance, campaignId: job.id, name, ok: false, removed: 0,
          error: e instanceof Error ? e.message : "failed",
        });
      } finally {
        if (pausedByUs) {
          try { await bisonWithRetry(instance, `/campaigns/${job.id}/resume`, { method: "PATCH" }); } catch { /* best effort */ }
        }
      }
    });

    return NextResponse.json({
      results: results.map((r) => ({
        instance: r.instance, campaignId: r.campaignId, name: r.name,
        ok: r.ok, removed: r.removed, note: r.note, error: r.error,
      })),
      removed: results.reduce((s, r) => s + r.removed, 0),
      failed: results.filter((r) => !r.ok).length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
