import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import { isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";
import { fetchCampaignSenderEmails } from "@/lib/attach-campaigns";

export const maxDuration = 300;

/**
 * POST /api/replacement/cross-tag-remove
 *
 * Campaign-centric bulk removal for the cross-tag audit ("Domains in
 * wrong-client campaigns"). Replaces the old flow that looped domains one at
 * a time and re-fetched each campaign's full sender list per domain — with
 * ~200 unique wrong campaigns shared across 2,000+ flagged domains, that
 * meant re-walking the same 15-per-page sender lists hundreds of times each
 * (hours of wall clock).
 *
 * New flow, per instance (instances run in parallel):
 *   1. One bulk Supabase read → inbox IDs for every flagged domain.
 *   2. Group by UNIQUE campaign → each campaign knows which domains feed it.
 *   3. Per campaign (pooled, concurrency 4):
 *        - candidates = union of the involved domains' inbox IDs
 *        - pause once (if active) → blind bulk DELETE remove-sender-emails →
 *          resume once. Removing an inbox that isn't attached is a no-op, so
 *          we skip fetching the campaign's sender list entirely.
 *        - If Bison rejects the blind batch (422), fall back once: cursor-walk
 *          the campaign's actual senders, intersect, remove exactly those.
 *   4. Domains whose every campaign succeeded are cleared from
 *      cross_tag_audit in bulk; failures stay flagged for retry.
 *
 * Body: { items: [{ instance, domain, campaigns: [{id, name, status}] }] }
 * Admin-only via middleware.
 */

interface ItemCampaign { id: number; name?: string; status?: string }
interface Item { instance: string; domain: string; campaigns: ItemCampaign[] }

interface CampaignJob {
  id: number;
  name: string;
  status: string;
  domains: Set<string>;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function bisonWriteWithRetry(
  instance: BisonInstanceSlug,
  path: string,
  init: RequestInit,
  attempts = 4,
): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i < attempts; i++) {
    const res = await bisonFetch(instance, path, init);
    if (res.ok) return res;
    if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
      last = res;
      const ra = parseInt(res.headers.get("retry-after") || "", 10);
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(8000, 500 * 2 ** i);
      await delay(wait + Math.floor(Math.random() * 300));
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

/** Bulk inbox-ID map for a set of domains on one instance. */
async function getInboxIdMap(
  instance: BisonInstanceSlug,
  domains: string[],
): Promise<Map<string, number[]>> {
  const supabase = getSupabaseAdmin();
  const map = new Map<string, number[]>();
  for (let i = 0; i < domains.length; i += 50) {
    const batch = domains.slice(i, i + 50);
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
        let arr = map.get(r.domain);
        if (!arr) { arr = []; map.set(r.domain, arr); }
        arr.push(r.id);
      }
      if (data.length < 1000) break;
      offset += 1000;
    }
  }
  return map;
}

interface CampaignResult {
  instance: string;
  campaignId: number;
  name: string;
  ok: boolean;
  removedUpTo: number; // candidates submitted (blind path) or exact (fallback)
  usedFallback: boolean;
  error?: string;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const items = (body?.items || []) as Item[];
    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: "items required" }, { status: 400 });
    }

    // Group by instance.
    const byInstance = new Map<BisonInstanceSlug, Item[]>();
    for (const it of items) {
      if (!isInstanceSlug(it.instance) || !it.domain) continue;
      let arr = byInstance.get(it.instance);
      if (!arr) { arr = []; byInstance.set(it.instance, arr); }
      arr.push(it);
    }

    const allResults: CampaignResult[] = [];
    const clearedDomains: { instance: string; domain: string }[] = [];

    await Promise.all(
      [...byInstance.entries()].map(async ([instance, instItems]) => {
        // 1. Bulk inbox map for every domain in this instance's chunk.
        const domains = [...new Set(instItems.map((i) => i.domain))];
        const inboxMap = await getInboxIdMap(instance, domains);

        // 2. Unique campaigns → involved domains.
        const jobs = new Map<number, CampaignJob>();
        for (const it of instItems) {
          for (const c of it.campaigns || []) {
            if (typeof c?.id !== "number") continue;
            let job = jobs.get(c.id);
            if (!job) {
              job = { id: c.id, name: c.name || `Campaign ${c.id}`, status: c.status || "", domains: new Set() };
              jobs.set(c.id, job);
            }
            job.domains.add(it.domain);
          }
        }

        // Track per-domain failure (any failed campaign keeps the domain flagged).
        const domainFailed = new Set<string>();
        const results: CampaignResult[] = [];

        // 3. Process unique campaigns with bounded concurrency.
        await pool([...jobs.values()], 4, async (job) => {
          const candidateSet = new Set<number>();
          for (const d of job.domains) {
            for (const id of inboxMap.get(d) || []) candidateSet.add(id);
          }
          const candidates = [...candidateSet];
          if (candidates.length === 0) {
            results.push({ instance, campaignId: job.id, name: job.name, ok: true, removedUpTo: 0, usedFallback: false });
            return;
          }

          const wasActive = job.status.trim().toLowerCase() === "active";
          let paused = false;
          let failed: string | undefined;
          let usedFallback = false;
          let submitted = 0;

          try {
            if (wasActive) {
              const p = await bisonWriteWithRetry(instance, `/campaigns/${job.id}/pause`, { method: "PATCH" });
              paused = p.ok;
              await delay(300);
            }

            // Blind bulk removal — removing a non-attached inbox is a no-op,
            // so we skip the expensive sender-list walk entirely.
            for (let i = 0; i < candidates.length; i += 100) {
              const batch = candidates.slice(i, i + 100);
              const res = await bisonWriteWithRetry(instance, `/campaigns/${job.id}/remove-sender-emails`, {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sender_email_ids: batch }),
              });
              if (res.ok) {
                submitted += batch.length;
                continue;
              }
              if (res.status === 404) {
                // Campaign gone in Bison — nothing to remove from. Success.
                submitted = candidates.length;
                break;
              }
              if (res.status === 422 && !usedFallback) {
                // Bison rejected the blind batch — fall back once to the exact
                // path: cursor-walk the campaign's actual senders, intersect.
                usedFallback = true;
                const actual = await fetchCampaignSenderEmails(instance, job.id);
                const toRemove = actual.filter((id) => candidateSet.has(id));
                submitted = 0;
                for (let j = 0; j < toRemove.length; j += 100) {
                  const b2 = toRemove.slice(j, j + 100);
                  const r2 = await bisonWriteWithRetry(instance, `/campaigns/${job.id}/remove-sender-emails`, {
                    method: "DELETE",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ sender_email_ids: b2 }),
                  });
                  if (!r2.ok) {
                    const t = await r2.text().catch(() => "");
                    throw new Error(`fallback remove batch: ${r2.status} ${t.slice(0, 150)}`);
                  }
                  submitted += b2.length;
                }
                break;
              }
              const t = await res.text().catch(() => "");
              throw new Error(`remove batch: ${res.status} ${t.slice(0, 150)}`);
            }
          } catch (e) {
            failed = e instanceof Error ? e.message : "remove failed";
          } finally {
            if (paused) {
              try { await bisonWriteWithRetry(instance, `/campaigns/${job.id}/resume`, { method: "PATCH" }); } catch { /* best effort */ }
            }
          }

          if (failed) {
            for (const d of job.domains) domainFailed.add(d);
          }
          results.push({
            instance,
            campaignId: job.id,
            name: job.name,
            ok: !failed,
            removedUpTo: submitted,
            usedFallback,
            error: failed,
          });
        });

        allResults.push(...results);

        // 4. Bulk-clear fully-successful domains from the audit table.
        const toClear = domains.filter((d) => !domainFailed.has(d));
        if (toClear.length > 0) {
          const supabase = getSupabaseAdmin();
          for (let i = 0; i < toClear.length; i += 100) {
            const batch = toClear.slice(i, i + 100);
            const { error } = await supabase
              .from("cross_tag_audit")
              .delete()
              .eq("instance", instance)
              .in("domain", batch);
            if (!error) {
              clearedDomains.push(...batch.map((domain) => ({ instance, domain })));
            }
          }
        }
      }),
    );

    const failures = allResults.filter((r) => !r.ok);
    return NextResponse.json({
      processed: items.length,
      campaignsProcessed: allResults.length,
      campaignsFailed: failures.length,
      fallbacksUsed: allResults.filter((r) => r.usedFallback).length,
      domainsCleared: clearedDomains.length,
      failures: failures.slice(0, 50).map((f) => ({
        instance: f.instance, campaignId: f.campaignId, name: f.name, error: f.error,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
