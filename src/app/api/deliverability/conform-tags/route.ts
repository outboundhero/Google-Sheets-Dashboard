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
 * a domain should have. For every domain in scope, this route finds senders
 * on that domain who are missing any of the domain's wanted tags and attaches
 * the missing tags.
 *
 * Plan phase (dryRun: true):
 *   Sources senders from Supabase's deliverability_inboxes cache instead of
 *   hitting Bison live. Bison's /sender-emails endpoint is fixed at 15 rows
 *   per page and offset-capped at 1000 pages, and a live per-domain scan of
 *   3000+ domains simply cannot complete inside Vercel's 300s ceiling. The
 *   nightly (well, every-2-days) sync-deliverability cron — now on cursor
 *   pagination so it actually walks past the 15,000-sender cap — keeps
 *   deliverability_inboxes complete. We report the cache freshness per
 *   instance in the response so the UI can flag staleness.
 *
 *   Trade-off: senders added since the last cron pass won't be in the plan
 *   until the next pass. Not a correctness issue — Bison's attach endpoint is
 *   idempotent on the apply side.
 *
 * Apply phase (dryRun: false):
 *   Re-derives the plan from Supabase (idempotent), resolves each wanted tag
 *   to its Bison tag_id per instance (creating it if missing), then attaches
 *   in batches of 100 via /tags/attach-to-sender-emails. Batches retry on
 *   429/5xx with jittered backoff so a transient blip no longer inflates the
 *   failed count. Per-sender events are appended to conform_tag_events.
 */

interface DomainRow {
  instance: BisonInstanceSlug;
  domain: string;
  tags: string[] | null;
}

interface InboxRow {
  id: number;
  instance: BisonInstanceSlug;
  email: string | null;
  domain: string | null;
  status: string | null;
  tags: { id?: number; name?: string }[] | null;
  synced_at: string | null;
}

interface BisonTag { id: number; name: string }

interface PerInstance {
  instance: BisonInstanceSlug;
  domainsScanned: number;
  domainsAffected: number;
  sendersAffected: number;
  attachmentsPlanned: number;
  sendersSkippedDisconnected: number;
  cacheSyncedAt: string | null;
}

interface PlanSampleRow {
  instance: BisonInstanceSlug;
  domain: string;
  sender_email: string | null;
  sender_id: number;
  missing_tags: string[];
}

function looksDisconnected(status: string): boolean {
  return (
    status.includes("disconnect") ||
    status.includes("reconnection") ||
    status.includes("login failed") ||
    status.includes("auth failed")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Retry Bison writes on transient 429/5xx with jittered backoff. Without this
// a single burst could inflate the failed count with attaches that would have
// succeeded on retry. Non-transient failures (400/404/422) return immediately
// so the caller can classify them.
async function bisonPostWithRetry(
  instance: BisonInstanceSlug,
  path: string,
  body: unknown,
  attempts = 4,
): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i < attempts; i++) {
    const res = await bisonFetch(instance, path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return res;
    if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
      last = res;
      const ra = parseInt(res.headers.get("retry-after") || "", 10);
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(8000, 500 * 2 ** i);
      await sleep(wait + Math.floor(Math.random() * 300));
      continue;
    }
    return res;
  }
  return last as Response;
}

/** Paginated read of deliverability_inboxes for the requested instances. */
async function loadInboxes(instances: BisonInstanceSlug[]): Promise<InboxRow[]> {
  const supabase = getSupabaseAdmin();
  const out: InboxRow[] = [];
  const PAGE = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("deliverability_inboxes")
      .select("id, instance, email, domain, status, tags, synced_at")
      .in("instance", instances)
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`inboxes read: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...(data as InboxRow[]));
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return out;
}

/** Domains with non-empty tags for the requested instances → wanted set map. */
async function loadDomainWantedMap(
  instances: BisonInstanceSlug[],
): Promise<{ byKey: Map<string, Set<string>>; scannedByInstance: Map<BisonInstanceSlug, number> }> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("deliverability_domains")
    .select("instance, domain, tags")
    .in("instance", instances);
  if (error) throw new Error(`domains read: ${error.message}`);
  const rows = (data || []) as DomainRow[];
  const byKey = new Map<string, Set<string>>();
  const scannedByInstance = new Map<BisonInstanceSlug, number>();
  for (const inst of instances) scannedByInstance.set(inst, 0);
  for (const r of rows) {
    if (!Array.isArray(r.tags) || r.tags.length === 0) continue;
    const wanted = new Set<string>();
    for (const t of r.tags) {
      const u = (t || "").trim().toUpperCase();
      if (u) wanted.add(u);
    }
    if (wanted.size === 0) continue;
    byKey.set(`${r.instance}::${r.domain}`, wanted);
    scannedByInstance.set(r.instance, (scannedByInstance.get(r.instance) ?? 0) + 1);
  }
  return { byKey, scannedByInstance };
}

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const instances = resolveInstances(searchParams);
    const body = await request.json().catch(() => ({}));
    const dryRun = body?.dryRun !== false;
    const skipDisconnected = body?.skipDisconnected !== false;

    // ── Common: build wanted-tags-per-domain + load all inboxes for scope ──
    const [wantedRes, inboxes] = await Promise.all([
      loadDomainWantedMap(instances),
      loadInboxes(instances),
    ]);
    const { byKey: wantedByKey, scannedByInstance } = wantedRes;

    // Freshest synced_at seen per instance — surfaced in the response so the
    // dialog can show "cache X hours old" for each Bison.
    const cacheSyncedAt = new Map<BisonInstanceSlug, string | null>();
    for (const inst of instances) cacheSyncedAt.set(inst, null);
    for (const i of inboxes) {
      if (!i.synced_at) continue;
      const cur = cacheSyncedAt.get(i.instance);
      if (!cur || i.synced_at > cur) cacheSyncedAt.set(i.instance, i.synced_at);
    }

    // ── Build the plan by diffing each inbox against its domain's wanted set ──
    const planByInstanceTag = new Map<BisonInstanceSlug, Map<string, Set<number>>>();
    const senderMetaByKey = new Map<string, { instance: BisonInstanceSlug; domain: string; email: string | null }>();
    const perInstance = new Map<BisonInstanceSlug, PerInstance>();
    const sample: PlanSampleRow[] = [];

    for (const inst of instances) {
      planByInstanceTag.set(inst, new Map<string, Set<number>>());
      perInstance.set(inst, {
        instance: inst,
        domainsScanned: scannedByInstance.get(inst) ?? 0,
        domainsAffected: 0,
        sendersAffected: 0,
        attachmentsPlanned: 0,
        sendersSkippedDisconnected: 0,
        cacheSyncedAt: cacheSyncedAt.get(inst) ?? null,
      });
    }

    const affectedDomainsByInstance = new Map<BisonInstanceSlug, Set<string>>();
    const affectedSendersByInstance = new Map<BisonInstanceSlug, Set<number>>();
    for (const inst of instances) {
      affectedDomainsByInstance.set(inst, new Set());
      affectedSendersByInstance.set(inst, new Set());
    }

    for (const inbox of inboxes) {
      if (!inbox.email || !inbox.domain) continue;
      const inst = inbox.instance;
      const stats = perInstance.get(inst);
      if (!stats) continue;

      if (skipDisconnected && looksDisconnected((inbox.status ?? "").toLowerCase())) {
        stats.sendersSkippedDisconnected++;
        continue;
      }

      const wanted = wantedByKey.get(`${inst}::${inbox.domain}`);
      if (!wanted || wanted.size === 0) continue;

      const has = new Set<string>();
      for (const t of inbox.tags || []) {
        const u = (t?.name || "").trim().toUpperCase();
        if (u) has.add(u);
      }
      const missing: string[] = [];
      for (const w of wanted) if (!has.has(w)) missing.push(w);
      if (missing.length === 0) continue;

      affectedDomainsByInstance.get(inst)!.add(inbox.domain);
      affectedSendersByInstance.get(inst)!.add(inbox.id);
      stats.attachmentsPlanned += missing.length;

      senderMetaByKey.set(`${inst}:${inbox.id}`, {
        instance: inst,
        domain: inbox.domain,
        email: inbox.email,
      });

      const tagMap = planByInstanceTag.get(inst)!;
      for (const tagU of missing) {
        let bag = tagMap.get(tagU);
        if (!bag) { bag = new Set(); tagMap.set(tagU, bag); }
        bag.add(inbox.id);
      }

      if (sample.length < 100) {
        sample.push({
          instance: inst,
          domain: inbox.domain,
          sender_email: inbox.email,
          sender_id: inbox.id,
          missing_tags: missing,
        });
      }
    }

    for (const inst of instances) {
      const stats = perInstance.get(inst)!;
      stats.domainsAffected = affectedDomainsByInstance.get(inst)!.size;
      stats.sendersAffected = affectedSendersByInstance.get(inst)!.size;
    }

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        source: "supabase-cache",
        instances,
        totals: {
          domainsScanned: [...perInstance.values()].reduce((s, p) => s + p.domainsScanned, 0),
          domainsAffected: [...perInstance.values()].reduce((s, p) => s + p.domainsAffected, 0),
          sendersAffected: [...perInstance.values()].reduce((s, p) => s + p.sendersAffected, 0),
          attachmentsPlanned: [...perInstance.values()].reduce((s, p) => s + p.attachmentsPlanned, 0),
          sendersSkippedDisconnected: [...perInstance.values()].reduce((s, p) => s + p.sendersSkippedDisconnected, 0),
        },
        perInstance: [...perInstance.values()],
        cacheSyncedAt: Object.fromEntries(cacheSyncedAt),
        sample,
      });
    }

    // ─── Apply phase ──────────────────────────────────────────────────────
    const batchId = randomUUID();
    let applied = 0;
    let failed = 0;
    const failures: { instance: string; tag: string; reason: string }[] = [];
    const appliedBySender = new Map<
      string,
      { instance: BisonInstanceSlug; sender_id: number; sender_email: string | null; domain: string; applied_tags: string[] }
    >();
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

      // Resolve tag names → IDs; create missing tags.
      const listRes = await bisonFetch(inst, `/tags`);
      if (!listRes.ok) {
        const reason = `Failed to list tags: ${listRes.status}`;
        for (const tag of tagToSenders.keys()) {
          failures.push({ instance: inst, tag, reason });
          failed++;
        }
        continue;
      }
      const tagsJson = await listRes.json();
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
          const attachRes = await bisonPostWithRetry(
            inst,
            `/tags/attach-to-sender-emails`,
            { tag_ids: [resolved.id], sender_email_ids: batch },
          );
          if (attachRes.ok) {
            okThisTag += batch.length;
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

    // Persist events. Soft-fail if the table doesn't exist yet — the Bison
    // work already happened and we don't want to fail the response over a
    // logging miss. SQL is in supabase-conform-tag-events.sql.
    if (eventRows.length > 0) {
      const supabase = getSupabaseAdmin();
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
      source: "supabase-cache",
      instances,
      batchId,
      applied,
      failed,
      failures: failures.slice(0, 50),
      perInstance: [...perInstance.values()],
      cacheSyncedAt: Object.fromEntries(cacheSyncedAt),
      appliedSenders: [...appliedBySender.values()],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
