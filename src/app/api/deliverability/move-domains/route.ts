import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import { isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";
import {
  findDomainAnyAccount,
  listPlatformConnections,
  setDomainTags,
  uploadDomainToPlatform,
  INBOXING_MAX_TAGS,
} from "@/lib/inboxing";
import {
  DEFAULT_INBOXING_ACCOUNT,
  inboxingConnectionFor,
  isInboxingAccount,
  type InboxingAccount,
} from "@/lib/inboxing-accounts";

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
 *   3. we poll the target until the senders are visible, then register the
 *      target rows in Supabase and repoint the order.
 *
 * The SOURCE copy is deliberately LEFT IN PLACE — after a move the domain
 * lives on BOTH instances, and the FE offers a separate, confirmed "remove
 * from previous instance" step (the Delete Domains flow) rather than deleting
 * automatically.
 *
 * A domain that stalls mid-flight (upload jobs still processing when the
 * request budget runs out) is reported as "uploading" and is safe to re-run:
 * the tag PUT replaces and the upload skips already-uploaded emails
 * (skip_verified).
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
// Domain → its Inboxing UUID *and* which Inboxing login holds it. A domain
// only exists on one of the two accounts, and the key/connection used for
// tags + upload must be that account's (a null column = the original account).
interface InboxingRef {
  id: string;
  account: InboxingAccount;
}

async function loadInboxingIds(domains: string[]): Promise<Map<string, InboxingRef>> {
  const supabase = getSupabaseAdmin();
  const map = new Map<string, InboxingRef>();
  for (let i = 0; i < domains.length; i += 100) {
    const { data } = await supabase
      .from("inbox_orders")
      .select("domain, provider_domain_id, inboxing_account")
      .eq("provider", "inboxing")
      .in("domain", domains.slice(i, i + 100));
    for (const r of (data || []) as { domain: string; provider_domain_id: string | null; inboxing_account: string | null }[]) {
      if (r.provider_domain_id) {
        map.set(r.domain.toLowerCase(), {
          id: r.provider_domain_id,
          account: isInboxingAccount(r.inboxing_account) ? r.inboxing_account : DEFAULT_INBOXING_ACCOUNT,
        });
      }
    }
  }
  return map;
}

// Some instances' /sender-emails?search= is slow (FacilityReach ~12s vs
// outboundhero ~0.5s). Guard every search with a hard abort timeout so a slow
// instance can never hang the request; the caller retries next poll cycle.
const SEARCH_TIMEOUT_MS = 11_000;
async function bisonFetchT(instance: BisonInstanceSlug, path: string): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  try {
    return await bisonFetch(instance, path, { signal: ctrl.signal });
  } catch {
    return null; // aborted / network — treat as "couldn't check this cycle"
  } finally {
    clearTimeout(timer);
  }
}

/** Fast readiness probe: how many senders the instance reports for `domain`
 *  (search meta.total, ONE call). -1 = the search timed out / errored. */
async function targetSenderCount(instance: BisonInstanceSlug, domain: string): Promise<number> {
  const res = await bisonFetchT(instance, `/sender-emails?search=${encodeURIComponent(domain)}&page=1&per_page=15`);
  if (!res || !res.ok) return -1;
  const json = await res.json().catch(() => null);
  const payload = Array.isArray(json) ? json[0] : json;
  if (typeof payload?.meta?.total === "number") return payload.meta.total;
  return Array.isArray(payload?.data) ? payload.data.length : -1;
}

/** All senders on `instance` whose email domain is exactly `domain`. Only run
 *  once the readiness probe says they've arrived — per_page=100 keeps it to a
 *  page or two even for 49 mailboxes, each guarded by the abort timeout. */
async function fetchSendersOnInstance(instance: BisonInstanceSlug, domain: string): Promise<SenderEmail[]> {
  const found = new Map<number, SenderEmail>();
  let page = 1;
  while (page <= 5) {
    const res = await bisonFetchT(instance, `/sender-emails?search=${encodeURIComponent(domain)}&page=${page}&per_page=100`);
    if (!res || !res.ok) break;
    const json = await res.json().catch(() => null);
    const payload = Array.isArray(json) ? json[0] : json;
    const data: SenderEmail[] = payload?.data || [];
    for (const inbox of data) {
      if (inbox.email.split("@")[1]?.toLowerCase() === domain.toLowerCase()) found.set(inbox.id, inbox);
    }
    const lastPage = payload?.meta?.last_page || 1;
    if (page >= lastPage) break;
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

/**
 * Preserve the domain's lifetime metrics + warmup progress across the move.
 * The source's stored totals are ALREADY combined (they include any prior
 * carryover), so SETting them onto the target's carryover captures the full
 * lineage and is idempotent on re-runs. Also re-keys the source's trailing-
 * rate snapshot history to the target so Reply/Bounce 10/15/30d stay
 * continuous immediately. Best-effort: a failure here never fails the move
 * (the mailboxes have already landed on the target).
 */
async function captureCarryover(source: BisonInstanceSlug, target: BisonInstanceSlug, domain: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  try {
    // Source's displayed (combined) totals + warmup start.
    const { data: src } = await supabase
      .from("deliverability_domains")
      .select("total_sent, total_replied, total_bounced, domain_created_at, warmup_status")
      .eq("instance", source)
      .eq("domain", domain)
      .maybeSingle();
    if (!src) return; // nothing to carry (source already gone)

    // Earliest warmup start across source + any existing target row.
    const { data: tgt } = await supabase
      .from("deliverability_domains")
      .select("domain_created_at")
      .eq("instance", target)
      .eq("domain", domain)
      .maybeSingle();
    const starts = [src.domain_created_at, tgt?.domain_created_at].filter(Boolean) as string[];
    const warmupStart = starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : null;

    await supabase.from("deliverability_domain_carryover").upsert(
      [{
        instance: target,
        domain,
        carried_sent: src.total_sent || 0,
        carried_replied: src.total_replied || 0,
        carried_bounced: src.total_bounced || 0,
        warmup_started_at: warmupStart,
        warmup_status_carried: src.warmup_status || null,
        updated_at: new Date().toISOString(),
      }],
      { onConflict: "instance,domain" },
    );

    // Re-key the source's snapshot history to the target instance (trailing).
    const { data: snaps } = await supabase
      .from("deliverability_domain_snapshots")
      .select("snapshot_date, total_sent, total_replied, total_bounced")
      .eq("instance", source)
      .eq("domain", domain);
    if (snaps && snaps.length > 0) {
      const copied = snaps.map((s) => ({ ...s, instance: target, domain }));
      for (let i = 0; i < copied.length; i += 500) {
        await supabase
          .from("deliverability_domain_snapshots")
          .upsert(copied.slice(i, i + 500), { onConflict: "instance,domain,snapshot_date" });
      }
    }
  } catch (e) {
    console.error(`[move/carryover] ${domain} ${source}->${target}:`, e instanceof Error ? e.message : e);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const domains = ([...new Set((body?.domains || []) as string[])]).map((d) => String(d).trim().toLowerCase()).filter(Boolean);
    if (domains.length === 0) {
      return NextResponse.json({ error: "domains required" }, { status: 400 });
    }
    // submit/poll are always apply-mode (the FE may omit dryRun:false on them).
    const isApplyMode = body?.mode === "submit" || body?.mode === "poll";
    const dryRun = !isApplyMode && body?.dryRun !== false;
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
          inboxingId: inboxingIds.get(domain)?.id ?? null, // null → resolved by name at apply
          inboxingAccount: inboxingIds.get(domain)?.account ?? null,
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
    // Three modes:
    //   "submit"   — Phase 1 only (tag-sync + upload). Returns each domain as
    //                "uploading" with {sourceInstance, expected} for the FE to poll.
    //   "poll"     — given the FE's in-flight set, does ONE arrival check per
    //                domain and finalizes any that have fully landed. Fast.
    //   "combined" — legacy: submit + poll + finalize in one long request.
    // The FE uses submit+poll so progress is live and no single request blocks
    // for minutes; combined is kept for backward-compat.
    const mode: "submit" | "poll" | "combined" =
      body?.mode === "submit" ? "submit" : body?.mode === "poll" ? "poll" : "combined";
    const supabase = getSupabaseAdmin();

    interface MoveResult {
      domain: string;
      status: "done" | "uploading" | "skipped" | "failed";
      stage?: string;
      detail?: string;
      error?: string;
      sourceInstance?: BisonInstanceSlug;
      expected?: number;
      landed?: number;
    }
    const results: MoveResult[] = [];

    // ── POLL: check arrival for the FE-supplied in-flight set + finalize. ──
    // Readiness is a single fast meta.total probe per domain (parallel, timeout-
    // guarded) — NEVER the slow full paging every cycle. Only when the count has
    // reached `expected` do we do the (bounded) full fetch to register.
    if (mode === "poll") {
      if (!target) return NextResponse.json({ error: "targetInstance required" }, { status: 400 });
      const inflight = (Array.isArray(body?.inflight) ? body.inflight : []) as { domain: string; sourceInstance: string; expected: number }[];
      const counts = await Promise.all(
        inflight.map((f) => targetSenderCount(target, String(f.domain || "").toLowerCase())),
      );
      let anyArrived = false;
      for (let i = 0; i < inflight.length; i++) {
        const f = inflight[i];
        const dom = String(f.domain || "").toLowerCase();
        if (!dom || !isInstanceSlug(f.sourceInstance)) { results.push({ domain: dom, status: "failed", error: "bad in-flight entry" }); continue; }
        const expected = Number(f.expected) > 0 ? Number(f.expected) : 1;
        const cnt = counts[i];
        if (cnt >= expected && cnt > 0) {
          try {
            const senders = await fetchSendersOnInstance(target, dom);
            if (senders.length >= expected && senders.length > 0) {
              await registerOnTarget(target, dom, senders);
              await captureCarryover(f.sourceInstance as BisonInstanceSlug, target, dom);
              await supabase.from("inbox_orders").update({ instance: target }).eq("provider", "inboxing").eq("domain", dom);
              results.push({ domain: dom, status: "done", sourceInstance: f.sourceInstance as BisonInstanceSlug, landed: senders.length, detail: `${senders.length} inboxes now on ${target}` });
              anyArrived = true;
            } else {
              results.push({ domain: dom, status: "uploading", landed: senders.length, expected, detail: "finalizing" });
            }
          } catch (e) {
            results.push({ domain: dom, status: "uploading", expected, error: e instanceof Error ? e.message : "finalize failed" });
          }
        } else {
          // cnt < 0 = the target search was too slow this cycle → retry next.
          results.push({ domain: dom, status: "uploading", landed: cnt < 0 ? undefined : cnt, expected, detail: cnt < 0 ? "target search slow — retrying" : "landing" });
        }
      }
      if (anyArrived) { try { await supabase.rpc("rebuild_domain_stats"); } catch { /* best-effort */ } }
      return NextResponse.json({ results, mode: "poll" });
    }

    // ── SUBMIT / COMBINED: need target + connection. ──
    const platformConnectionId = String(body?.platformConnectionId || "");
    if (!target || !platformConnectionId) {
      return NextResponse.json({ error: "targetInstance and platformConnectionId required" }, { status: 400 });
    }
    const deadline = Date.now() + 240_000; // combined-mode polling headroom

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
      let ref = inboxingIds.get(domain) ?? null;
      try {
        if (!ref) {
          const hit = await findDomainAnyAccount(domain);
          if (!hit) throw new Error("not found on either Inboxing account");
          ref = { id: hit.id, account: hit.account };
        }
      } catch (e) {
        results.push({ domain, status: "failed", stage: "resolve", error: e instanceof Error ? e.message : "failed" });
        continue;
      }
      const inboxingId = ref.id;
      // The FE sends the connection id it saw for the default account; a domain
      // on the other login needs THAT login's connection for the same target.
      const connectionId =
        ref.account === DEFAULT_INBOXING_ACCOUNT
          ? platformConnectionId
          : inboxingConnectionFor(target, ref.account) || platformConnectionId;

      // Stage: tag sync (before upload, so sync_tags carries the right tags).
      const tags = (src.tags || []).map((t) => t.trim()).filter(Boolean);
      try {
        await setDomainTags(inboxingId, tags, ref.account);
      } catch (e) {
        results.push({ domain, status: "failed", stage: "tag_sync", error: e instanceof Error ? e.message : "failed" });
        continue;
      }

      // Stage: platform upload (async on Inboxing's side).
      try {
        const up = await uploadDomainToPlatform(inboxingId, connectionId, ref.account);
        const expected = up.jobsCreated > 0 ? up.jobsCreated : (src.inbox_count || 1);
        inFlight.push({ domain, source: src.instance, expected });
      } catch (e) {
        results.push({ domain, status: "failed", stage: "upload", error: e instanceof Error ? e.message : "failed" });
        continue;
      }
    }

    // SUBMIT mode: uploads are queued on Inboxing — hand the in-flight set back
    // to the FE, which polls (mode:"poll") with live progress. No blocking wait.
    if (mode === "submit") {
      for (const f of inFlight) {
        results.push({ domain: f.domain, status: "uploading", sourceInstance: f.source, expected: f.expected, detail: "upload submitted" });
      }
      return NextResponse.json({ results, mode: "submit" });
    }

    // ── COMBINED (legacy) — Phase 2 poll + Phase 3 finalize in-request. ──
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

    // Phase 3 — arrived: register on target + repoint order. The source copy
    // is deliberately LEFT IN PLACE — the domain now lives on BOTH instances,
    // and the FE offers a separate "remove from previous instance" step
    // (the Delete Domains flow) so removal is an explicit, confirmed action.
    for (const f of arrived) {
      try {
        await registerOnTarget(target, f.domain, f.senders!);
        // Preserve lifetime metrics + warmup + trailing history onto the target.
        await captureCarryover(f.source, target, f.domain);
        await supabase.from("inbox_orders").update({ instance: target }).eq("provider", "inboxing").eq("domain", f.domain);
        results.push({
          domain: f.domain,
          status: "done",
          sourceInstance: f.source,
          detail: `${f.senders!.length} inboxes now on ${target} · still on ${f.source} (remove separately)`,
        });
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
