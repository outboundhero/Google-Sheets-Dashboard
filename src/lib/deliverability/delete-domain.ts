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
}

/** GET a Bison path with patient retry on 429/5xx. */
async function bisonGetWithRetry(instance: BisonInstanceSlug, path: string): Promise<Response | null> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await bisonFetch(instance, path, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) return res;
      if (res.status === 429 || res.status >= 500) {
        const ra = parseInt(res.headers.get("retry-after") || "", 10);
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(15_000, 600 * 2 ** attempt);
        await delay(wait + Math.floor(Math.random() * 400));
        continue;
      }
      return res; // non-transient (e.g. 404/422) — caller stops
    } catch {
      await delay(Math.min(15_000, 600 * 2 ** attempt));
    }
  }
  return null;
}

/** Every sender Bison currently reports whose email domain is EXACTLY `domain`. */
async function listBisonSenders(instance: BisonInstanceSlug, domain: string): Promise<SenderLite[]> {
  const found = new Map<number, SenderLite>();
  let page = 1;
  while (page <= SEARCH_MAX_PAGES) {
    // per_page=100 (Bison accepts it — campaigns sync uses the same): the old
    // per_page=15 meant up to 40 paged calls per verify; on a rate-limited
    // instance that blew the cron's whole time budget on a single domain.
    const res = await bisonGetWithRetry(instance, `/sender-emails?search=${encodeURIComponent(domain)}&page=${page}&per_page=100`);
    if (!res || !res.ok) break;
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
    page++;
  }
  return [...found.values()];
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
): Promise<{ deleted: number; notFound: number; removedIds: number[]; failures: DeleteFailure[] }> {
  const removedIds: number[] = [];
  const failures: DeleteFailure[] = [];
  let deleted = 0;
  let notFound = 0;
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
      if (result.outcome === "deleted") deleted++;
      else notFound++;
      removedIds.push(s.id);
    }
  }
  return { deleted, notFound, removedIds, failures };
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
  const { data: remaining } = await supabase
    .from("deliverability_inboxes")
    .select("tags, type, emails_sent_count, total_replied_count, bounced_count")
    .eq("instance", instance)
    .eq("domain", domain);
  if (!remaining || remaining.length === 0) return;
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
  for (const s of await listBisonSenders(instance, dom)) candidates.set(s.id, s.email);

  // 2. Delete → re-verify sweeps until Bison reports zero (or budget exhausted).
  const removedIds = new Set<number>();
  const failureMap = new Map<number, DeleteFailure>();
  let deleted = 0;
  let notFound = 0;
  let toDelete: SenderLite[] = [...candidates.entries()].map(([id, email]) => ({ id, email }));

  for (let sweep = 0; sweep < MAX_SWEEPS && toDelete.length > 0; sweep++) {
    const r = await deleteBatch(instance, dom, toDelete);
    deleted += r.deleted;
    notFound += r.notFound;
    for (const id of r.removedIds) { removedIds.add(id); failureMap.delete(id); }
    for (const f of r.failures) failureMap.set(f.id, f);

    // Ask Bison what's actually left; those become the next sweep's targets.
    if (sweep < MAX_SWEEPS - 1) await delay(500);
    const survivors = await listBisonSenders(instance, dom);
    if (survivors.length === 0) { toDelete = []; break; }
    toDelete = survivors;
  }

  const finalRemaining = await listBisonSenders(instance, dom);
  const remainingIds = new Set(finalRemaining.map((s) => s.id));
  // Anything Bison no longer reports is gone — clear it from the failure list.
  for (const id of [...failureMap.keys()]) if (!remainingIds.has(id)) failureMap.delete(id);
  const failures = [...failureMap.values()];

  // 3. LeadSync cleanup. If Bison is fully clean, drop the whole (instance,
  //    domain) footprint; otherwise remove only what's confirmed gone + reconcile.
  let domainRowRemoved = false;
  if (finalRemaining.length === 0) {
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
    inboxesDeleted: deleted,
    notFound,
    failed: failures.length,
    failures,
    remainingInBison: finalRemaining.length,
    domainRowRemoved,
  };
}
