import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import { isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";
import { fetchCampaignSenderEmails } from "@/lib/attach-campaigns";

export const maxDuration = 300;

/**
 * POST /api/replacement/cross-tag-remove
 *
 * Campaign-centric removal for the cross-tag audit. The FE groups the whole
 * selection by UNIQUE campaign and sends batches of campaign jobs — each
 * unique campaign is processed exactly once no matter how many domains feed
 * it (in practice ~200 shared campaigns across 2,000+ flagged domains).
 *
 * Per campaign job:
 *   1. Resolve the involved domains' inbox IDs (bulk Supabase read).
 *   2. Fetch the campaign's CURRENT sender list — offset pages fetched in
 *      PARALLEL (pages are independent; a 200-page walk becomes ~14 rounds).
 *      Falls back to sequential cursor if the campaign exceeds the offset cap.
 *   3. Intersect → only genuinely-attached contaminating inboxes.
 *   4. Pause once (if active) → DELETE the intersection in batches → resume.
 *
 * Second action — { action: "clearDomains", domains: [{instance, domain}] }:
 *   bulk-deletes cleaned rows from cross_tag_audit. The FE calls this after
 *   all campaign batches finish, only for domains whose every campaign
 *   succeeded.
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
  attached: number;   // campaign's total senders at fetch time
  removed: number;    // contaminating inboxes actually detached
  error?: string;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Concurrency budget: CAMPAIGN_CONC × PAGE_CONC is the worst-case number of
// simultaneous requests against ONE Bison instance (flagged domains cluster
// heavily on a single instance). The first run at 4×12=48 exhausted retries
// on ~half the campaigns — Bison's ceiling is nearer ~20-25 sustained.
const CAMPAIGN_CONC = 3;       // campaign jobs in flight per request
const PAGE_CONC = 7;           // parallel offset pages per campaign fetch (3×7=21)
const OFFSET_PAGE_CAP = 990;   // Bison caps offset pagination at 1000 pages
const DELETE_BATCH = 300;      // ids per remove call (downshifts on 4xx)

async function bisonWithRetry(
  instance: BisonInstanceSlug,
  path: string,
  init?: RequestInit,
  attempts = 7,
): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i < attempts; i++) {
    const res = await bisonFetch(instance, path, init);
    if (res.ok) return res;
    if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
      last = res;
      const ra = parseInt(res.headers.get("retry-after") || "", 10);
      // Patient backoff — under sustained load a burst of 429s needs to be
      // waited OUT, not raced. Caps at 20s; total patience ≈ 60s.
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(20_000, 700 * 2 ** i);
      await delay(wait + Math.floor(Math.random() * 400));
      continue;
    }
    return res;
  }
  return last as Response;
}

async function pool<T>(items: T[], conc: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, () => worker()));
}

/**
 * Fetch a campaign's full sender-ID list FAST: page 1 reveals last_page, then
 * remaining offset pages are fetched in parallel (they're independent).
 * Returns null when the campaign is gone (404). Falls back to the sequential
 * cursor walk if the campaign exceeds Bison's 1000-page offset cap.
 */
async function fetchSenderIdsFast(instance: BisonInstanceSlug, campaignId: number): Promise<number[] | null> {
  const first = await bisonWithRetry(instance, `/campaigns/${campaignId}/sender-emails?page=1&per_page=100`);
  if (first.status === 404) return null;
  if (!first.ok) {
    const t = await first.text().catch(() => "");
    throw new Error(`senders page 1: ${first.status} ${t.slice(0, 120)}`);
  }
  const json = (await first.json()) as { data?: { id: number }[]; meta?: { last_page?: number } };
  const ids: number[] = (json.data || []).map((d) => d.id);
  const lastPage = json.meta?.last_page || 1;
  if (lastPage <= 1) return ids;

  if (lastPage > OFFSET_PAGE_CAP) {
    // Too big for offset pagination — sequential cursor walk (rare).
    return fetchCampaignSenderEmails(instance, campaignId);
  }

  const pages = Array.from({ length: lastPage - 1 }, (_, i) => i + 2);
  const perPage: number[][] = new Array(pages.length);
  let pageError: string | null = null;
  await pool(pages, PAGE_CONC, async (page, idx) => {
    if (pageError) return;
    const res = await bisonWithRetry(instance, `/campaigns/${campaignId}/sender-emails?page=${page}&per_page=100`);
    if (!res.ok) { pageError = `senders page ${page}: HTTP ${res.status}`; return; }
    try {
      const j = (await res.json()) as { data?: { id: number }[] };
      perPage[idx] = (j.data || []).map((d) => d.id);
    } catch {
      pageError = `senders page ${page}: bad JSON`;
    }
  });
  if (pageError) throw new Error(pageError);
  for (const arr of perPage) if (arr) ids.push(...arr);
  return ids;
}

/** Bulk inbox-ID map for a set of domains on one instance (memoized per request). */
async function getInboxIdMap(
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
      [...domainsByInstance.entries()].map(([inst, doms]) => getInboxIdMap(inst, [...doms], inboxCache)),
    );

    const results: JobResult[] = [];
    await pool(jobs, CAMPAIGN_CONC, async (job) => {
      if (!isInstanceSlug(job.instance)) {
        results.push({ instance: job.instance, campaignId: job.id, name: job.name || `Campaign ${job.id}`, ok: false, attached: 0, removed: 0, error: `unknown instance ${job.instance}` });
        return;
      }
      const instance = job.instance;
      const name = job.name || `Campaign ${job.id}`;

      const candidateSet = new Set<number>();
      for (const d of job.domains || []) {
        for (const id of inboxCache.get(`${instance}:${d}`) || []) candidateSet.add(id);
      }
      if (candidateSet.size === 0) {
        results.push({ instance, campaignId: job.id, name, ok: true, attached: 0, removed: 0 });
        return;
      }

      let paused = false;
      const wasActive = (job.status || "").trim().toLowerCase() === "active";
      try {
        // 1. Current senders — parallel offset fetch.
        const senders = await fetchSenderIdsFast(instance, job.id);
        if (senders === null) {
          // Campaign deleted in Bison — nothing to clean. Success.
          results.push({ instance, campaignId: job.id, name, ok: true, attached: 0, removed: 0 });
          return;
        }
        const toRemove = senders.filter((id) => candidateSet.has(id));
        if (toRemove.length === 0) {
          results.push({ instance, campaignId: job.id, name, ok: true, attached: senders.length, removed: 0 });
          return;
        }

        // 2. Pause once → remove intersection → resume once.
        if (wasActive) {
          const p = await bisonWithRetry(instance, `/campaigns/${job.id}/pause`, { method: "PATCH" });
          paused = p.ok;
          await delay(300);
        }

        let removed = 0;
        let batchSize = DELETE_BATCH;
        for (let i = 0; i < toRemove.length; ) {
          const batch = toRemove.slice(i, i + batchSize);
          const res = await bisonWithRetry(instance, `/campaigns/${job.id}/remove-sender-emails`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sender_email_ids: batch }),
          });
          if (res.ok) {
            removed += batch.length;
            i += batchSize;
            continue;
          }
          if ((res.status === 413 || res.status === 422 || res.status === 400) && batchSize > 100) {
            // Payload too big for Bison — downshift and retry the same window.
            batchSize = 100;
            continue;
          }
          const t = await res.text().catch(() => "");
          throw new Error(`remove batch at ${i}: ${res.status} ${t.slice(0, 120)}`);
        }

        results.push({ instance, campaignId: job.id, name, ok: true, attached: senders.length, removed });
      } catch (e) {
        results.push({
          instance, campaignId: job.id, name, ok: false, attached: 0, removed: 0,
          error: e instanceof Error ? e.message : "failed",
        });
      } finally {
        if (paused) {
          try { await bisonWithRetry(instance, `/campaigns/${job.id}/resume`, { method: "PATCH" }); } catch { /* best effort */ }
        }
      }
    });

    return NextResponse.json({
      results: results.map((r) => ({
        instance: r.instance, campaignId: r.campaignId, name: r.name,
        ok: r.ok, attached: r.attached, removed: r.removed, error: r.error,
      })),
      removed: results.reduce((s, r) => s + r.removed, 0),
      failed: results.filter((r) => !r.ok).length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
