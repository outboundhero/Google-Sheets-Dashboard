import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import { isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";
import {
  findDomainByName,
  listPlatformConnections,
  setDomainTags,
  uploadDomainToPlatform,
  INBOXING_MAX_TAGS,
} from "@/lib/inboxing";

export const maxDuration = 300;

/**
 * POST /api/deliverability/move-domains
 *
 * Moves Inboxing-provisioned domains (and their inboxes) from one Bison
 * instance to another. The mailbox credentials only exist on Inboxing's
 * side (Bison's API neither exposes passwords nor creates OAuth accounts),
 * so the move rides Inboxing's Platform Upload:
 *
 *   1. sync LeadSync tags → Inboxing (PUT /domains/{id}/tags), so that
 *   2. POST /domains/{id}/upload (async job queue, sync_tags: true) lands
 *      the senders on the TARGET instance already carrying the right tags,
 *   3. we poll the target until the senders are visible,
 *   4. only then delete the senders from the SOURCE instance and reconcile
 *      Supabase (source rows out, target rows in, inbox_orders repointed).
 *
 * A domain that stalls mid-flight (upload jobs still processing when the
 * request budget runs out) is reported as "uploading" and is safe to re-run:
 *! the tag PUT replaces, the upload skips already-uploaded emails
 * (skip_verified), and source cleanup only ever happens after arrival.
 *
 * Body:
 *   { dryRun: true,  domains: string[] }                                → plan + connections
 *   { dryRun: false, domains: string[], targetInstance, platformConnectionId } → execute batch
 *
 * Admin-only via middleware (POST — not in the viewer GET whitelist).
 */

interface DomainRowLite {
  instance: BisonInstanceSlug;
  domain: string;
  tags: string[] | null;
  inbox_count: number | null;
}

interface SenderEmail {
  id: number;
  name: string;
  email: string;
  daily_limit: number;
  type: string;
  status: string;
  warmup_enabled: boolean;
  tags: { id: number; name: string }[];
  emails_sent_count: number;
  total_replied_count: number;
  total_opened_count: number;
  bounced_count: number;
  created_at: string;
  updated_at: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hasInboxingTag = (tags: string[] | null) =>
  (tags || []).some((t) => (t || "").trim().toLowerCase().startsWith("inboxing"));

/** LeadSync rows for the requested domain names, across all instances. */
async function loadDomainRows(domains: string[]): Promise<Map<string, DomainRowLite[]>> {
  const supabase = getSupabaseAdmin();
  const byName = new Map<string, DomainRowLite[]>();
  for (let i = 0; i < domains.length; i += 100) {
    const batch = domains.slice(i, i + 100);
    const { data, error } = await supabase
      .from("deliverability_domains")
      .select("instance, domain, tags, inbox_count")
      .in("domain", batch);
    if (error) throw new Error(`deliverability_domains read: ${error.message}`);
    for (const r of (data || []) as DomainRowLite[]) {
      if (!isInstanceSlug(r.instance)) continue;
      const k = r.domain.toLowerCase();
      (byName.get(k) ?? byName.set(k, []).get(k)!).push(r);
    }
  }
  return byName;
}

/** Resolve which instance a domain would move FROM, given the target.
 *  1 row → that row. 2 rows where one IS the target → the other (this is the
 *  resume case after a partial move). Anything else → null (manual). */
function resolveSource(rows: DomainRowLite[], target: BisonInstanceSlug | null): DomainRowLite | null {
  if (rows.length === 1) return rows[0];
  if (rows.length === 2 && target) {
    const nonTarget = rows.filter((r) => r.instance !== target);
    if (nonTarget.length === 1) return nonTarget[0];
  }
  return null;
}

/** Inboxing UUIDs cached from past orders. */
async function loadInboxingIds(domains: string[]): Promise<Map<string, string>> {
  const supabase = getSupabaseAdmin();
  const map = new Map<string, string>();
  for (let i = 0; i < domains.length; i += 100) {
    const { data } = await supabase
      .from("inbox_orders")
      .select("domain, provider_domain_id")
      .eq("provider", "inboxing")
      .in("domain", domains.slice(i, i + 100));
    for (const r of (data || []) as { domain: string; provider_domain_id: string | null }[]) {
      if (r.provider_domain_id) map.set(r.domain.toLowerCase(), r.provider_domain_id);
    }
  }
  return map;
}

/** All senders on `instance` whose email domain is exactly `domain`
 *  (import-domain's search pattern). */
async function fetchSendersOnInstance(instance: BisonInstanceSlug, domain: string): Promise<SenderEmail[]> {
  const found = new Map<number, SenderEmail>();
  let page = 1;
  while (true) {
    const res = await bisonFetch(instance, `/sender-emails?search=${encodeURIComponent(domain)}&page=${page}&per_page=15`);
    if (!res.ok) break;
    const json = await res.json();
    const payload = Array.isArray(json) ? json[0] : json;
    const data: SenderEmail[] = payload.data || [];
    for (const inbox of data) {
      if (inbox.email.split("@")[1]?.toLowerCase() === domain.toLowerCase()) found.set(inbox.id, inbox);
    }
    const lastPage = payload.meta?.last_page || 1;
    if (page >= lastPage || page >= 20) break;
    page++;
  }
  return [...found.values()];
}

/** Upsert arrived senders as target-instance rows (import-domain's upsert). */
async function registerOnTarget(target: BisonInstanceSlug, domain: string, senders: SenderEmail[]): Promise<void> {
  const supabase = getSupabaseAdmin();
  const earliest = senders.reduce((min, s) => (s.created_at < min ? s.created_at : min), senders[0].created_at);
  await supabase.from("deliverability_domains").upsert(
    [{ instance: target, domain, domain_created_at: earliest, warmup_status: "open", synced_at: new Date().toISOString() }],
    { onConflict: "instance,domain", ignoreDuplicates: true },
  );
  const rows = senders.map((s) => ({
    id: s.id,
    instance: target,
    name: s.name,
    email: s.email,
    domain,
    status: s.status,
    type: s.type,
    daily_limit: s.daily_limit,
    warmup_enabled: s.warmup_enabled,
    tags: s.tags,
    emails_sent_count: s.emails_sent_count,
    total_replied_count: s.total_replied_count,
    total_opened_count: s.total_opened_count,
    bounced_count: s.bounced_count,
    created_at: s.created_at,
    updated_at: s.updated_at,
    synced_at: new Date().toISOString(),
  }));
  for (let i = 0; i < rows.length; i += 500) {
    await supabase.from("deliverability_inboxes").upsert(rows.slice(i, i + 500), { onConflict: "instance,id" });
  }
}

/** Delete the domain's senders from the source instance (bulk-delete's
 *  internals) + reconcile Supabase. Returns how many failed. */
async function cleanupSource(source: BisonInstanceSlug, domain: string): Promise<{ deleted: number; failed: number }> {
  const supabase = getSupabaseAdmin();
  const { data: inboxes } = await supabase
    .from("deliverability_inboxes")
    .select("id")
    .eq("instance", source)
    .eq("domain", domain);
  const ids = ((inboxes || []) as { id: number }[]).map((r) => r.id);
  const deletedIds: number[] = [];
  let failed = 0;
  // Patient per-delete retry — a mass delete without backoff collapses the
  // moment Bison's per-minute limit trips (the old bulk-delete lesson).
  const deleteOne = async (id: number): Promise<boolean> => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await bisonFetch(source, `/sender-emails/${id}`, { method: "DELETE", headers: { "Content-Type": "application/json" } });
        if (res.ok || res.status === 404) return true;
        if (res.status === 429 || res.status >= 500) {
          const ra = parseInt(res.headers.get("retry-after") || "", 10);
          const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(15_000, 600 * 2 ** attempt);
          await sleep(wait + Math.floor(Math.random() * 300));
          continue;
        }
        return false;
      } catch {
        await sleep(Math.min(15_000, 600 * 2 ** attempt));
      }
    }
    return false;
  };
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);
    const results = await Promise.all(batch.map(async (id) => ({ id, ok: await deleteOne(id) })));
    for (const r of results) {
      if (r.ok) deletedIds.push(r.id);
      else failed++;
    }
  }
  if (deletedIds.length > 0) {
    await supabase.from("deliverability_inboxes").delete().eq("instance", source).in("id", deletedIds);
  }
  if (failed === 0) {
    await supabase.from("deliverability_domains").delete().eq("instance", source).eq("domain", domain);
  }
  return { deleted: deletedIds.length, failed };
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const domains = ([...new Set((body?.domains || []) as string[])]).map((d) => String(d).trim().toLowerCase()).filter(Boolean);
    if (domains.length === 0) {
      return NextResponse.json({ error: "domains required" }, { status: 400 });
    }
    const dryRun = body?.dryRun !== false;
    const target: BisonInstanceSlug | null = isInstanceSlug(body?.targetInstance) ? body.targetInstance : null;

    const rowsByName = await loadDomainRows(domains);
    const inboxingIds = await loadInboxingIds(domains);

    // ── Dry run: routing plan + the account's Email Bison connections ──────
    if (dryRun) {
      let connections: Awaited<ReturnType<typeof listPlatformConnections>> = [];
      let connectionsError: string | null = null;
      try {
        connections = (await listPlatformConnections()).filter((c) =>
          c.platform.replace(/[^a-z]/g, "").includes("bison"),
        );
      } catch (e) {
        connectionsError = e instanceof Error ? e.message : "failed to load platform connections";
      }

      const plan = domains.map((domain) => {
        const rows = rowsByName.get(domain) || [];
        if (rows.length === 0) return { domain, action: "skip" as const, skipReason: "not found in LeadSync" };
        if (rows.length > 2) return { domain, action: "skip" as const, skipReason: `exists on ${rows.length} instances — move manually` };
        // With no target chosen yet, 2-instance rows are provisionally OK
        // (the resume case); apply re-validates against the actual target.
        const src = rows.length === 1 ? rows[0] : null;
        const anyRow = src ?? rows[0];
        if (!rows.some((r) => hasInboxingTag(r.tags))) {
          return { domain, action: "skip" as const, skipReason: "not an Inboxing domain (no Inboxing tag)" };
        }
        const tagCount = (anyRow.tags || []).length;
        if (tagCount > INBOXING_MAX_TAGS) {
          return { domain, action: "skip" as const, skipReason: `${tagCount} tags — Inboxing caps at ${INBOXING_MAX_TAGS}, trim tags first` };
        }
        return {
          domain,
          action: "move" as const,
          sourceInstances: rows.map((r) => r.instance),
          inboxCount: rows.reduce((s, r) => s + (r.inbox_count || 0), 0),
          // Per-instance counts so the dialog can show exactly how many
          // inboxes move once a target is chosen (for 2-instance rows only
          // the non-target copy moves — the summed count is misleading).
          perInstance: rows.map((r) => ({ instance: r.instance, inboxCount: r.inbox_count || 0 })),
          inboxingId: inboxingIds.get(domain) ?? null, // null → resolved by name at apply
          tags: anyRow.tags || [],
        };
      });

      return NextResponse.json({
        connections,
        connectionsError,
        plan,
        counts: {
          movable: plan.filter((p) => p.action === "move").length,
          skipped: plan.filter((p) => p.action === "skip").length,
        },
      });
    }

    // ── Apply ───────────────────────────────────────────────────────────────
    const platformConnectionId = String(body?.platformConnectionId || "");
    if (!target || !platformConnectionId) {
      return NextResponse.json({ error: "targetInstance and platformConnectionId required" }, { status: 400 });
    }

    interface MoveResult {
      domain: string;
      status: "done" | "uploading" | "skipped" | "failed";
      stage?: string;
      detail?: string;
      error?: string;
    }
    const results: MoveResult[] = [];
    const supabase = getSupabaseAdmin();
    const deadline = Date.now() + 240_000; // leave headroom under maxDuration

    // Phase 1 — per domain: validate, tag-sync, upload. Fast calls.
    interface InFlight { domain: string; source: BisonInstanceSlug; expected: number; senders?: SenderEmail[] }
    const inFlight: InFlight[] = [];
    for (const domain of domains) {
      const rows = rowsByName.get(domain) || [];
      const src = resolveSource(rows, target);
      if (rows.length === 0) { results.push({ domain, status: "skipped", error: "not found in LeadSync" }); continue; }
      if (rows.length === 1 && rows[0].instance === target) { results.push({ domain, status: "skipped", error: "already on target instance" }); continue; }
      if (!src) { results.push({ domain, status: "skipped", error: "exists on multiple instances — move manually" }); continue; }
      if (!hasInboxingTag(src.tags)) { results.push({ domain, status: "skipped", error: "not an Inboxing domain" }); continue; }

      // Inboxing domain id: cached order id, else resolve by name.
      let inboxingId = inboxingIds.get(domain) ?? null;
      try {
        if (!inboxingId) {
          const hit = await findDomainByName(domain);
          if (!hit) throw new Error("not found on the Inboxing account");
          inboxingId = hit.id;
        }
      } catch (e) {
        results.push({ domain, status: "failed", stage: "resolve", error: e instanceof Error ? e.message : "failed" });
        continue;
      }

      // Stage: tag sync (before upload, so sync_tags carries the right tags).
      const tags = (src.tags || []).map((t) => t.trim()).filter(Boolean);
      try {
        await setDomainTags(inboxingId, tags);
      } catch (e) {
        results.push({ domain, status: "failed", stage: "tag_sync", error: e instanceof Error ? e.message : "failed" });
        continue;
      }

      // Stage: platform upload (async on Inboxing's side).
      try {
        const up = await uploadDomainToPlatform(inboxingId, platformConnectionId);
        const expected = up.jobsCreated > 0 ? up.jobsCreated : (src.inbox_count || 1);
        inFlight.push({ domain, source: src.instance, expected });
      } catch (e) {
        results.push({ domain, status: "failed", stage: "upload", error: e instanceof Error ? e.message : "failed" });
        continue;
      }
    }

    // Phase 2 — poll the target until each domain's senders are visible.
    const arrived: InFlight[] = [];
    let pending = [...inFlight];
    while (pending.length > 0 && Date.now() < deadline) {
      const still: InFlight[] = [];
      for (const f of pending) {
        try {
          const senders = await fetchSendersOnInstance(target, f.domain);
          if (senders.length >= f.expected && senders.length > 0) {
            arrived.push({ ...f, senders });
          } else {
            still.push(f);
          }
        } catch {
          still.push(f);
        }
      }
      pending = still;
      if (pending.length > 0 && Date.now() < deadline) await sleep(10_000);
    }
    for (const f of pending) {
      results.push({
        domain: f.domain,
        status: "uploading",
        stage: "arrival",
        detail: "Upload submitted — senders not visible on the target yet. Re-run Move for this domain later to finish (safe: nothing was deleted).",
      });
    }

    // Phase 3 — arrived: register on target, clean up source, repoint order.
    for (const f of arrived) {
      try {
        await registerOnTarget(target, f.domain, f.senders!);
        const cl = await cleanupSource(f.source, f.domain);
        await supabase.from("inbox_orders").update({ instance: target }).eq("provider", "inboxing").eq("domain", f.domain);
        if (cl.failed > 0) {
          results.push({
            domain: f.domain, status: "failed", stage: "source_cleanup",
            error: `${cl.failed} sender(s) could not be deleted from ${f.source} — domain now on both instances; re-run Move to retry cleanup`,
          });
        } else {
          results.push({ domain: f.domain, status: "done", detail: `${f.senders!.length} inboxes now on ${target}, ${cl.deleted} removed from ${f.source}` });
        }
      } catch (e) {
        results.push({ domain: f.domain, status: "failed", stage: "finalize", error: e instanceof Error ? e.message : "failed" });
      }
    }

    if (arrived.length > 0) {
      try { await supabase.rpc("rebuild_domain_stats"); } catch { /* stats refresh best-effort */ }
    }

    return NextResponse.json({
      results,
      summary: {
        done: results.filter((r) => r.status === "done").length,
        uploading: results.filter((r) => r.status === "uploading").length,
        skipped: results.filter((r) => r.status === "skipped").length,
        failed: results.filter((r) => r.status === "failed").length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Move failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
