import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

// Authoritative deletion of every inbox under a (instance, domain) — used by
// BOTH the deliverability "Delete domains" workflow and the scheduled
// duplicate-domain deletion cron.
//
// Why this exists (the "1–2 inboxes remain in Bison" bug): the old bulk-delete
// only ever deleted the inbox IDs it found in Supabase. Any sender that Bison
// has but LeadSync never synced (or synced under a different casing) was
// invisible → it survived. Here we take the UNION of the Supabase rows AND a
// live Bison `?search=<domain>` lookup, delete everything, then RE-QUERY Bison
// and sweep again until it reports zero senders for the domain (or we exhaust
// the sweep budget). Every Bison call retries patiently on 429/5xx.

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DELETE_CONC = 10;      // concurrent DELETEs per batch (kind to Bison's per-minute window)
const FETCH_TIMEOUT_MS = 60_000; // Bison's sender search can legitimately take 30s+ on busy instances (facilityreach) — only abort truly hung calls
const MAX_ATTEMPTS = 5;      // per-request retry attempts on transient errors (429/5xx/network)
const MAX_SWEEPS = 4;        // delete → re-verify passes before giving up
const SEARCH_MAX_PAGES = 40; // safety cap when paging the domain search
// Per-search wall-clock caps. Deleting must never be starved by verification:
// the DELETE calls are the useful work, the seed search is only discovery.
// The FINAL verify gets a much bigger slice — it's the one that decides whether
// the domain is finished, and a domain that keeps failing to verify is what
// leaves rows looping in the queue.
const SEARCH_BUDGET_MS = 45_000;
// facilityreach throttles sender-search hard since 2026-09-06 — one attempt
// can take 30-60s, so 45s rarely fits even a single completed search. A wider
// seed window lets ONE search land, and a completed zero-sender seed is
// itself the verification (see below).
const SEARCH_BUDGET_SLOW_MS = 120_000;
const SLOW_SEARCH_INSTANCES = new Set<string>(["facilityreach"]);
const VERIFY_BUDGET_MS = 150_000;

interface SenderLite { id: number; email: string }

export interface DeleteFailure {
  id: number;
  email: string;
  domain: string;
  instance: string;
  status: number | null;
  error: string;
}

export interface DeleteDomainResult {
  instance: string;
  domain: string;
  inboxesDeleted: number;   // confirmed removed from Bison this run
  notFound: number;         // Bison couldn't identify → already gone
  failed: number;           // still failing after retries + sweeps
  failures: DeleteFailure[];
  remainingInBison: number; // senders Bison still reports for the domain (0 = fully clean)
  domainRowRemoved: boolean;
  /**
   * true = the final Bison verification search was cut short (rate limits /
   * budget), so `remainingInBison: 0` is UNCONFIRMED. Callers must not treat
   * the domain as finished; retry instead.
   */
  verifyIncomplete: boolean;
}

/**
 * GET a Bison path with patient retry on 429/5xx, bounded by `deadline`.
 *
 * The deadline is load-bearing: facilityreach's sender search can simply HANG,
 * and 5 attempts × a 60s request timeout burns 300s inside what the caller
 * thinks is a 45s budget — that is what killed whole delete rows on "row
 * timeout" before anything was deleted. Each attempt is capped at whatever
 * time is actually left.
 */
async function bisonGetWithRetry(
  instance: BisonInstanceSlug,
  path: string,
  deadline = Infinity,
): Promise<Response | null> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const left = deadline - Date.now();
    if (left <= 1000) return null;
    try {
      const res = await bisonFetch(instance, path, {
        signal: AbortSignal.timeout(Math.min(FETCH_TIMEOUT_MS, left)),
      });
      if (res.ok) return res;
      if (res.status === 429 || res.status >= 500) {
        const ra = parseInt(res.headers.get("retry-after") || "", 10);
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(15_000, 600 * 2 ** attempt);
        await delay(Math.min(wait + Math.floor(Math.random() * 400), Math.max(0, deadline - Date.now())));
        continue;
      }
      return res; // non-transient (e.g. 404/422) — caller stops
    } catch {
      await delay(Math.min(15_000, 600 * 2 ** attempt, Math.max(0, deadline - Date.now())));
    }
  }
  return null;
}

/**
 * Every sender Bison currently reports whose email domain is EXACTLY `domain`.
 *
 * Time-budgeted: on a rate-limited instance (facilityreach 429s constantly) a
 * single page can cost ~60s of retry backoff, so an unbounded page walk used to
 * eat the caller's entire row budget and abort the whole delete before it had
 * deleted anything ("row timeout after 130s", 0 deleted — Spencer 2026-08-12).
 * `complete: false` means the walk was cut short, so a zero/short result must
 * NOT be read as "Bison is clean".
 */
async function listBisonSenders(
  instance: BisonInstanceSlug,
  domain: string,
  budgetMs?: number,
): Promise<{ senders: SenderLite[]; complete: boolean }> {
  budgetMs ??= SLOW_SEARCH_INSTANCES.has(instance) ? SEARCH_BUDGET_SLOW_MS : SEARCH_BUDGET_MS;
  const found = new Map<number, SenderLite>();
  const deadline = Date.now() + budgetMs;
  let complete = true;
  let page = 1;
  while (page <= SEARCH_MAX_PAGES) {
    if (Date.now() > deadline) { complete = false; break; }
    // per_page=100 (Bison accepts it — campaigns sync uses the same): the old
    // per_page=15 meant up to 40 paged calls per verify; on a rate-limited
    // instance that blew the cron's whole time budget on a single domain.
    const res = await bisonGetWithRetry(instance, `/sender-emails?search=${encodeURIComponent(domain)}&page=${page}&per_page=100`, deadline);
    if (!res || !res.ok) { complete = false; break; }
    const json = await res.json().catch(() => null);
    const payload = Array.isArray(json) ? json[0] : json;
    const data: { id: number; email: string }[] = payload?.data || [];
    for (const s of data) {
      if (s.email?.split("@")[1]?.toLowerCase() === domain.toLowerCase()) {
        found.set(s.id, { id: s.id, email: s.email });
      }
    }
    const lastPage = payload?.meta?.last_page || 1;
    if (page >= lastPage) break;
    if (page >= SEARCH_MAX_PAGES) { complete = false; break; }
    page++;
  }
  return { senders: [...found.values()], complete };
}

/** DELETE one sender with patient retry. */
async function deleteSenderEmail(
  instance: BisonInstanceSlug,
  id: number,
): Promise<{ outcome: "deleted" | "not_found" | "failed"; status: number | null; error: string }> {
  let lastStatus: number | null = null;
  let lastError = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS + 1; attempt++) {
    try {
      const res = await bisonFetch(instance, `/sender-emails/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.ok) return { outcome: "deleted", status: res.status, error: "" };
      if (res.status === 404) return { outcome: "not_found", status: 404, error: "not found in Bison" };
      lastStatus = res.status;
      lastError = (await res.text().catch(() => "")).slice(0, 150) || `HTTP ${res.status}`;
      if (res.status === 429 || res.status >= 500) {
        const ra = parseInt(res.headers.get("retry-after") || "", 10);
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(15_000, 600 * 2 ** attempt);
        await delay(wait + Math.floor(Math.random() * 400));
        continue;
      }
      return { outcome: "failed", status: lastStatus, error: lastError }; // 400/401/403/422 won't improve
    } catch (e) {
      lastStatus = null;
      lastError = e instanceof Error ? e.message : "network error";
      await delay(Math.min(15_000, 600 * 2 ** attempt));
    }
  }
  return { outcome: "failed", status: lastStatus, error: `exhausted retries: ${lastError}` };
}

/** Delete a batch of sender IDs concurrently; classify outcomes. */
async function deleteBatch(
  instance: BisonInstanceSlug,
  domain: string,
  senders: SenderLite[],
): Promise<{ deletedIds: number[]; notFoundIds: number[]; removedIds: number[]; failures: DeleteFailure[] }> {
  const removedIds: number[] = [];
  const deletedIds: number[] = [];
  const notFoundIds: number[] = [];
  const failures: DeleteFailure[] = [];
  for (let i = 0; i < senders.length; i += DELETE_CONC) {
    const batch = senders.slice(i, i + DELETE_CONC);
    const results = await Promise.all(
      batch.map(async (s) => ({ s, result: await deleteSenderEmail(instance, s.id) })),
    );
    for (const { s, result } of results) {
      if (result.outcome === "failed") {
        failures.push({ id: s.id, email: s.email || `#${s.id}`, domain, instance, status: result.status, error: result.error });
        continue;
      }
      if (result.outcome === "deleted") deletedIds.push(s.id);
      else notFoundIds.push(s.id);
      removedIds.push(s.id);
    }
  }
  return { deletedIds, notFoundIds, removedIds, failures };
}

/** Remove sender IDs from LeadSync's inbox table (chunked). */
async function purgeInboxIds(instance: BisonInstanceSlug, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const supabase = getSupabaseAdmin();
  for (let i = 0; i < ids.length; i += 500) {
    await supabase
      .from("deliverability_inboxes")
      .delete()
      .eq("instance", instance)
      .in("id", ids.slice(i, i + 500));
  }
}

/** Re-aggregate the (instance, domain) row from whatever inboxes remain. */
async function reconcileDomain(instance: BisonInstanceSlug, domain: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: remaining, error } = await supabase
    .from("deliverability_inboxes")
    .select("tags, type, emails_sent_count, total_replied_count, bounced_count")
    .eq("instance", instance)
    .eq("domain", domain);
  // A read error means we don't know the truth — leave the row alone. Zero rows
  // is a real answer though: bailing out there left the domain row frozen at its
  // pre-delete count, so the UI kept showing the instance chip with 49 inboxes
  // long after every inbox was gone.
  if (error || !remaining) return;
  const tagSet = new Set<string>();
  let sent = 0, replied = 0, bounced = 0, outlook = 0, google = 0;
  for (const inbox of remaining as { tags?: { name?: string }[]; type?: string; emails_sent_count?: number; total_replied_count?: number; bounced_count?: number }[]) {
    if (Array.isArray(inbox.tags)) for (const t of inbox.tags) { if (t.name) tagSet.add(t.name); }
    sent += inbox.emails_sent_count || 0;
    replied += inbox.total_replied_count || 0;
    bounced += inbox.bounced_count || 0;
    if (inbox.type?.includes("microsoft")) outlook++;
    else if (inbox.type?.includes("google")) google++;
  }
  await supabase
    .from("deliverability_domains")
    .update({
      inbox_count: remaining.length,
      tags: Array.from(tagSet).sort(),
      total_sent: sent,
      total_replied: replied,
      total_bounced: bounced,
      outlook_count: outlook,
      google_count: google,
    })
    .eq("instance", instance)
    .eq("domain", domain);
}

/**
 * Delete EVERY inbox under (instance, domain) from Bison + LeadSync, verifying
 * against Bison until nothing remains. Idempotent and safe to re-run.
 */
export async function deleteDomainFromInstance(
  instance: BisonInstanceSlug,
  domain: string,
): Promise<DeleteDomainResult> {
  const supabase = getSupabaseAdmin();
  const dom = domain.toLowerCase();

  // 1. Seed candidates from BOTH Supabase and a live Bison search (union).
  const candidates = new Map<number, string>(); // id → email
  const { data: sbRows } = await supabase
    .from("deliverability_inboxes")
    .select("id, email")
    .eq("instance", instance)
    .eq("domain", dom);
  for (const r of (sbRows || []) as { id: number; email: string | null }[]) {
    candidates.set(r.id, r.email || `#${r.id}`);
  }
  const seed = await listBisonSenders(instance, dom);
  for (const s of seed.senders) candidates.set(s.id, s.email);

  // 2. Delete → re-verify sweeps until Bison reports zero (or budget exhausted).
  const removedIds = new Set<number>();
  const failureMap = new Map<number, DeleteFailure>();
  // Counted as SETS of sender ids, not running totals. Bison's sender search
  // lags its own deletes, so a sweep re-lists senders we already deleted and
  // deletes them again (200 again) — summing per-sweep counts reported ~4x the
  // real number ("781 inboxes deleted" for 4×49 senders).
  const deletedIds = new Set<number>();
  const notFoundIds = new Set<number>();
  let toDelete: SenderLite[] = [...candidates.entries()].map(([id, email]) => ({ id, email }));

  // Reliability of the LAST verification, not of every search: a complete
  // search returning 0 is authoritative even if the seed walk was cut short.
  let finalVerifyComplete = false;
  let confirmedZero = false; // a sweep's re-verify already reported 0 → skip the extra final search (each search is 30–60s on slow instances like facilityreach)
  // Already-empty domain: Supabase knows nothing and the seed search COMPLETED
  // at zero — that IS the verification. Demanding a second search here is what
  // wedged the whole queue when facilityreach throttled searches (2026-09-06:
  // every empty row burned the 150s verify budget, failed it, and requeued
  // forever — found via the ?limit=1 probe on cleanbridgefacilitycare.com).
  if (candidates.size === 0 && seed.complete) {
    confirmedZero = true;
    finalVerifyComplete = true;
  }
  for (let sweep = 0; sweep < MAX_SWEEPS && toDelete.length > 0; sweep++) {
    const r = await deleteBatch(instance, dom, toDelete);
    for (const id of r.deletedIds) { deletedIds.add(id); notFoundIds.delete(id); }
    // Only "not found" if we never got a successful delete for it — a 404 on a
    // later sweep just means the earlier delete finally propagated.
    for (const id of r.notFoundIds) if (!deletedIds.has(id)) notFoundIds.add(id);
    for (const id of r.removedIds) { removedIds.add(id); failureMap.delete(id); }
    for (const f of r.failures) failureMap.set(f.id, f);

    // Ask Bison what's actually left; those become the next sweep's targets.
    if (sweep < MAX_SWEEPS - 1) await delay(500);
    const sweepRes = await listBisonSenders(instance, dom);
    if (sweepRes.senders.length === 0) {
      toDelete = [];
      if (sweepRes.complete) { confirmedZero = true; finalVerifyComplete = true; }
      break; // nothing more to delete either way; completeness decides "done"
    }
    toDelete = sweepRes.senders;
  }

  let finalRemaining: SenderLite[] = [];
  if (!confirmedZero) {
    const fin = await listBisonSenders(instance, dom, VERIFY_BUDGET_MS);
    finalRemaining = fin.senders;
    finalVerifyComplete = fin.complete;
  }
  const verifyIncomplete = !finalVerifyComplete;
  const remainingIds = new Set(finalRemaining.map((s) => s.id));
  // Anything Bison no longer reports is gone — clear it from the failure list.
  for (const id of [...failureMap.keys()]) if (!remainingIds.has(id)) failureMap.delete(id);
  const failures = [...failureMap.values()];

  // 3. LeadSync cleanup. If Bison is fully clean, drop the whole (instance,
  //    domain) footprint; otherwise remove only what's confirmed gone + reconcile.
  let domainRowRemoved = false;
  if (finalRemaining.length === 0 && finalVerifyComplete) {
    await supabase.from("deliverability_inboxes").delete().eq("instance", instance).eq("domain", dom);
    await supabase.from("deliverability_domains").delete().eq("instance", instance).eq("domain", dom);
    await supabase.from("deliverability_domain_carryover").delete().eq("instance", instance).eq("domain", dom);
    domainRowRemoved = true;
  } else {
    await purgeInboxIds(instance, [...removedIds]);
    await reconcileDomain(instance, dom);
  }

  return {
    instance,
    domain: dom,
    inboxesDeleted: deletedIds.size,
    notFound: notFoundIds.size,
    failed: failures.length,
    failures,
    remainingInBison: finalRemaining.length,
    domainRowRemoved,
    verifyIncomplete,
  };
}
