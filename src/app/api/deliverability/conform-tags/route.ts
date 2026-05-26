import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch, resolveInstances } from "@/lib/bison";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

export const maxDuration = 300;

/**
 * POST /api/deliverability/conform-tags?instances=<csv>
 *
 * LeadSync's deliverability_domains.tags is the source of truth for what tags
 * a domain should have. For every domain in scope, this route queries Bison
 * LIVE for the senders currently on that domain (so deleted/disconnected senders
 * that linger in our cache don't get false-positive plans), and for each live
 * sender it computes which of the domain's wanted tags they're missing and
 * attaches them.
 *
 * Phase 1 — Plan: { dryRun: true } returns counts + a 100-row sample.
 * Phase 2 — Apply: { dryRun: false } actually attaches the tags via Bison
 *   /tags/attach-to-sender-emails, grouped by (instance, tag).
 */

interface DomainRow {
  instance: BisonInstanceSlug;
  domain: string;
  tags: string[] | null;
}

interface BisonTag { id: number; name: string }

interface BisonSender {
  id: number;
  email: string;
  name?: string;
  status?: string;
  tags?: BisonTag[];
}

interface PerInstance {
  instance: BisonInstanceSlug;
  domainsScanned: number;
  domainsAffected: number;
  sendersAffected: number;
  attachmentsPlanned: number;
}

interface PlanSampleRow {
  instance: BisonInstanceSlug;
  domain: string;
  sender_email: string;
  sender_id: number;
  missing_tags: string[];
}

/** Fetch every sender on a given domain from Bison, paginated. The search param
 *  filters by free-text; we double-check the returned senders' email domain
 *  matches exactly to guard against fuzzy matches (e.g. "acme.com" matching
 *  "acme.com.au"). */
async function fetchLiveSendersByDomain(
  instance: BisonInstanceSlug,
  domain: string,
): Promise<BisonSender[]> {
  const out: BisonSender[] = [];
  const target = domain.toLowerCase();
  let page = 1;
  for (;;) {
    const res = await bisonFetch(
      instance,
      `/sender-emails?search=${encodeURIComponent(domain)}&per_page=100&page=${page}`,
    );
    if (!res.ok) {
      throw new Error(`Bison /sender-emails ${res.status} for ${domain}`);
    }
    const json = await res.json();
    const items: BisonSender[] = json.data || [];
    for (const s of items) {
      const senderDomain = s.email?.split("@")[1]?.toLowerCase();
      if (senderDomain === target) out.push(s);
    }
    const lastPage = json.meta?.last_page || 1;
    if (page >= lastPage) break;
    page++;
  }
  return out;
}

function looksDisconnected(status: string): boolean {
  return (
    status.includes("disconnect") ||
    status.includes("reconnection") ||
    status.includes("login failed") ||
    status.includes("auth failed")
  );
}

/** Run an async fn on items with a fixed concurrency cap. */
async function pool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const instances = resolveInstances(searchParams);
    const body = await request.json().catch(() => ({}));
    const dryRun = body?.dryRun !== false;
    const skipDisconnected = body?.skipDisconnected !== false;
    const supabase = getSupabaseAdmin();

    // 1. Domains with non-empty tags, scoped to requested instances.
    const { data: rawDomains, error: dErr } = await supabase
      .from("deliverability_domains")
      .select("instance, domain, tags")
      .in("instance", instances);
    if (dErr) throw new Error(`domains: ${dErr.message}`);
    const domains = (rawDomains || []).filter(
      (d): d is DomainRow =>
        Array.isArray((d as DomainRow).tags) && ((d as DomainRow).tags?.length ?? 0) > 0,
    );

    // Group domains by instance for parallel processing per Bison.
    const domainsByInstance = new Map<BisonInstanceSlug, DomainRow[]>();
    for (const inst of instances) domainsByInstance.set(inst, []);
    for (const d of domains) {
      const arr = domainsByInstance.get(d.instance);
      if (arr) arr.push(d);
    }

    // 2. For each (instance, domain): fetch live senders from Bison, diff against
    //    the domain's wanted tags, accumulate a plan.
    const planByInstanceTag = new Map<BisonInstanceSlug, Map<string, Set<number>>>();
    // Keep sender metadata so the apply phase can emit a per-sender result
    // and persist conform_tag_events rows.
    const senderMetaByKey = new Map<string, { instance: BisonInstanceSlug; domain: string; email: string | null }>();
    const perInstanceStats = new Map<BisonInstanceSlug, PerInstance>();
    const sample: PlanSampleRow[] = [];
    let totalAttachments = 0;

    // Run all 4 instances in parallel; within each instance, 5 domain lookups in flight.
    await Promise.all(
      instances.map(async (inst) => {
        const instDomains = domainsByInstance.get(inst) || [];
        const tagToSenders = new Map<string, Set<number>>();
        const affectedDomains = new Set<string>();
        const affectedSenders = new Set<number>();
        let instAttachments = 0;

        await pool(instDomains, 5, async (dRow) => {
          const wanted = new Set((dRow.tags ?? []).map((t) => t.toUpperCase()));
          if (wanted.size === 0) return;

          let liveSenders: BisonSender[];
          try {
            liveSenders = await fetchLiveSendersByDomain(inst, dRow.domain);
          } catch (e) {
            // Skip this domain on Bison error; record it in stats? Keep silent for now.
            console.warn(`[conform-tags:${inst}] ${dRow.domain}: ${(e as Error).message}`);
            return;
          }

          for (const sender of liveSenders) {
            if (skipDisconnected && looksDisconnected((sender.status ?? "").toLowerCase())) continue;
            const has = new Set(
              (sender.tags || [])
                .map((t) => (t?.name ?? "").toUpperCase())
                .filter(Boolean),
            );
            const missing: string[] = [];
            for (const w of wanted) {
              if (!has.has(w)) missing.push(w);
            }
            if (missing.length === 0) continue;

            affectedDomains.add(dRow.domain);
            affectedSenders.add(sender.id);
            instAttachments += missing.length;
            senderMetaByKey.set(`${inst}:${sender.id}`, {
              instance: inst,
              domain: dRow.domain,
              email: sender.email ?? null,
            });

            for (const tagU of missing) {
              let bag = tagToSenders.get(tagU);
              if (!bag) { bag = new Set(); tagToSenders.set(tagU, bag); }
              bag.add(sender.id);
            }

            if (sample.length < 100) {
              sample.push({
                instance: inst,
                domain: dRow.domain,
                sender_email: sender.email,
                sender_id: sender.id,
                missing_tags: missing,
              });
            }
          }
        });

        planByInstanceTag.set(inst, tagToSenders);
        totalAttachments += instAttachments;
        perInstanceStats.set(inst, {
          instance: inst,
          domainsScanned: instDomains.length,
          domainsAffected: affectedDomains.size,
          sendersAffected: affectedSenders.size,
          attachmentsPlanned: instAttachments,
        });
      }),
    );

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        live: true,
        instances,
        totals: {
          domainsScanned: [...perInstanceStats.values()].reduce((s, p) => s + p.domainsScanned, 0),
          domainsAffected: [...perInstanceStats.values()].reduce((s, p) => s + p.domainsAffected, 0),
          sendersAffected: [...perInstanceStats.values()].reduce((s, p) => s + p.sendersAffected, 0),
          attachmentsPlanned: totalAttachments,
        },
        perInstance: [...perInstanceStats.values()],
        sample,
      });
    }

    // ─── Apply phase ─── resolve tag IDs per instance (creating if missing), then attach.
    // Also track per-sender applied tags so we can return + persist the list.
    const batchId = randomUUID();
    let applied = 0;
    let failed = 0;
    const failures: { instance: string; tag: string; reason: string }[] = [];
    // Per (instance, sender_id) → applied tag names
    const appliedBySender = new Map<
      string,
      { instance: BisonInstanceSlug; sender_id: number; sender_email: string | null; domain: string; applied_tags: string[] }
    >();
    // Event rows to insert into conform_tag_events at the end (one per attempt).
    type EventRow = {
      batch_id: string;
      instance: string;
      sender_id: number;
      sender_email: string | null;
      domain: string | null;
      tag_id: number | null;
      tag_name: string;
      status: "ok" | "failed";
      error: string | null;
    };
    const eventRows: EventRow[] = [];

    for (const [inst, tagToSenders] of planByInstanceTag) {
      if (tagToSenders.size === 0) continue;

      const tagsRes = await bisonFetch(inst, `/tags`);
      if (!tagsRes.ok) {
        const reason = `Failed to list tags: ${tagsRes.status}`;
        for (const tag of tagToSenders.keys()) {
          failures.push({ instance: inst, tag, reason });
          failed++;
        }
        continue;
      }
      const tagsJson = await tagsRes.json();
      const currentTags: BisonTag[] = tagsJson.data || [];
      const byUpperName = new Map(currentTags.map((t) => [t.name.toUpperCase(), t]));

      for (const [tagU, senderIdSet] of tagToSenders) {
        let resolved = byUpperName.get(tagU);
        if (!resolved) {
          const createRes = await bisonFetch(inst, `/tags`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: tagU }),
          });
          if (createRes.ok) {
            const created = await createRes.json();
            const newTag: BisonTag = created.data || created;
            if (newTag?.id) {
              resolved = newTag;
              byUpperName.set(tagU, newTag);
            }
          }
          if (!resolved) {
            failures.push({ instance: inst, tag: tagU, reason: `Could not resolve or create tag` });
            failed++;
            continue;
          }
        }

        const ids = [...senderIdSet];
        let okThisTag = 0;
        for (let i = 0; i < ids.length; i += 100) {
          const batch = ids.slice(i, i + 100);
          const attachRes = await bisonFetch(inst, `/tags/attach-to-sender-emails`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tag_ids: [resolved.id], sender_email_ids: batch }),
          });
          if (attachRes.ok) {
            okThisTag += batch.length;
            // Record successes
            for (const senderId of batch) {
              const key = `${inst}:${senderId}`;
              const meta = senderMetaByKey.get(key);
              let entry = appliedBySender.get(key);
              if (!entry) {
                entry = {
                  instance: inst,
                  sender_id: senderId,
                  sender_email: meta?.email ?? null,
                  domain: meta?.domain ?? "",
                  applied_tags: [],
                };
                appliedBySender.set(key, entry);
              }
              entry.applied_tags.push(resolved.name);
              eventRows.push({
                batch_id: batchId,
                instance: inst,
                sender_id: senderId,
                sender_email: meta?.email ?? null,
                domain: meta?.domain ?? null,
                tag_id: resolved.id,
                tag_name: resolved.name,
                status: "ok",
                error: null,
              });
            }
          } else {
            const txt = await attachRes.text().catch(() => "");
            const reason = `attach batch ${i}-${i + batch.length}: ${attachRes.status} ${txt.slice(0, 150)}`;
            failures.push({ instance: inst, tag: resolved.name, reason });
            // Record failures
            for (const senderId of batch) {
              const meta = senderMetaByKey.get(`${inst}:${senderId}`);
              eventRows.push({
                batch_id: batchId,
                instance: inst,
                sender_id: senderId,
                sender_email: meta?.email ?? null,
                domain: meta?.domain ?? null,
                tag_id: resolved.id,
                tag_name: resolved.name,
                status: "failed",
                error: reason,
              });
            }
          }
        }
        applied += okThisTag;
        if (okThisTag < ids.length) failed += ids.length - okThisTag;
      }
    }

    // Persist events to Supabase. Soft-fail if the table doesn't exist yet —
    // the apply already happened on Bison, and we don't want to fail the
    // whole response over a logging miss. The SQL is in
    // supabase-conform-tag-events.sql for the operator to run.
    if (eventRows.length > 0) {
      try {
        for (let i = 0; i < eventRows.length; i += 500) {
          const batch = eventRows.slice(i, i + 500);
          const { error: insErr } = await supabase.from("conform_tag_events").insert(batch);
          if (insErr) {
            console.warn(`[conform-tags] failed to write events (${insErr.message}) — run supabase-conform-tag-events.sql`);
            break;
          }
        }
      } catch (e) {
        console.warn(`[conform-tags] event log write threw:`, e);
      }
    }

    return NextResponse.json({
      dryRun: false,
      live: true,
      instances,
      batchId,
      applied,
      failed,
      failures: failures.slice(0, 50),
      perInstance: [...perInstanceStats.values()],
      appliedSenders: [...appliedBySender.values()],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
