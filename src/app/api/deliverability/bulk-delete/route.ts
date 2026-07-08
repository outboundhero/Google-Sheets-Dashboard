import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch, resolveInstances } from "@/lib/bison";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

export const maxDuration = 300;

/**
 * POST /api/deliverability/bulk-delete?instances=<csv>
 *
 * Deletes the given domains' inboxes from their Bison instance(s) + LeadSync.
 * The dialog drives this one domain per request (Vercel-timeout-safe).
 *
 * v2 fixes (the 18,344-failure incident):
 *  - `?instances=` is honored (the old flow never passed an instance, so every
 *    delete silently targeted DEFAULT_INSTANCE regardless of where the
 *    selected rows actually lived).
 *  - Patient retry per delete (429/5xx, honor Retry-After) — mass deletes
 *    used to fail wholesale the moment Bison's per-minute limit tripped.
 *  - Per-inbox outcome classification: deleted / notFound (Bison can't
 *    identify the account → still removed from LeadSync) / failed with
 *    {email, status, error} so the UI can show WHAT happened.
 *
 * Second action — { action: "purge", domains } — removes the domains' rows
 * from LeadSync WITHOUT touching Bison: the escape hatch for inboxes Bison
 * persistently refuses to delete/identify.
 *
 * Admin-only via middleware (POST).
 */

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DELETE_CONC = 10; // was 20 — kinder to Bison's per-minute window

interface InboxRow { id: number; email: string | null; domain: string; instance: BisonInstanceSlug }
interface Failure { id: number; email: string; domain: string; instance: string; status: number | null; error: string }

/** DELETE one sender with patient retry. Returns the classified outcome. */
async function deleteSenderEmail(
  instance: BisonInstanceSlug,
  id: number,
): Promise<{ outcome: "deleted" | "not_found" | "failed"; status: number | null; error: string }> {
  let lastStatus: number | null = null;
  let lastError = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await bisonFetch(instance, `/sender-emails/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) return { outcome: "deleted", status: res.status, error: "" };
      if (res.status === 404) return { outcome: "not_found", status: 404, error: "not found in Bison" };
      lastStatus = res.status;
      lastError = (await res.text().catch(() => "")).slice(0, 150) || `HTTP ${res.status}`;
      // Retry only transient statuses; 400/401/403/422 won't improve.
      if (res.status === 429 || res.status >= 500) {
        const ra = parseInt(res.headers.get("retry-after") || "", 10);
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(15_000, 600 * 2 ** attempt);
        await delay(wait + Math.floor(Math.random() * 400));
        continue;
      }
      return { outcome: "failed", status: lastStatus, error: lastError };
    } catch (e) {
      lastStatus = null;
      lastError = e instanceof Error ? e.message : "network error";
      await delay(Math.min(15_000, 600 * 2 ** attempt));
    }
  }
  return { outcome: "failed", status: lastStatus, error: `exhausted retries: ${lastError}` };
}

/** Re-aggregate or delete the (instance, domain) row after inbox removals. */
async function reconcileDomain(instance: BisonInstanceSlug, domain: string): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const { count } = await supabase
    .from("deliverability_inboxes")
    .select("id", { count: "exact", head: true })
    .eq("instance", instance)
    .eq("domain", domain);

  if (count === 0) {
    await supabase.from("deliverability_domains").delete().eq("instance", instance).eq("domain", domain);
    return true; // domain row removed
  }

  const { data: remaining } = await supabase
    .from("deliverability_inboxes")
    .select("tags, type, emails_sent_count, total_replied_count, bounced_count")
    .eq("instance", instance)
    .eq("domain", domain);
  if (remaining) {
    const tagSet = new Set<string>();
    let sent = 0, replied = 0, bounced = 0, outlook = 0, google = 0;
    for (const inbox of remaining) {
      if (Array.isArray(inbox.tags)) {
        for (const t of inbox.tags) { if (t.name) tagSet.add(t.name); }
      }
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
  return false;
}

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const instances = resolveInstances(searchParams);
    const body = (await request.json()) as { domains?: string[]; action?: string };
    const domains = body.domains || [];
    if (!domains.length) {
      return NextResponse.json({ error: "domains required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();

    // ── Purge: remove from LeadSync only, Bison untouched ─────────────────
    if (body.action === "purge") {
      let inboxRows = 0;
      let domainRows = 0;
      for (const instance of instances) {
        const { count } = await supabase
          .from("deliverability_inboxes")
          .select("id", { count: "exact", head: true })
          .eq("instance", instance)
          .in("domain", domains);
        await supabase.from("deliverability_inboxes").delete().eq("instance", instance).in("domain", domains);
        const { count: dCount } = await supabase
          .from("deliverability_domains")
          .select("domain", { count: "exact", head: true })
          .eq("instance", instance)
          .in("domain", domains);
        await supabase.from("deliverability_domains").delete().eq("instance", instance).in("domain", domains);
        inboxRows += count ?? 0;
        domainRows += dCount ?? 0;
      }
      return NextResponse.json({ success: true, purged: true, inboxRows, domainRows });
    }

    // ── Delete from Bison + LeadSync ───────────────────────────────────────
    // 1. The domains' inbox rows across every SCOPED instance — exactly the
    //    rows the user sees in the table under the current switcher.
    const inboxes: InboxRow[] = [];
    for (const instance of instances) {
      const { data, error } = await supabase
        .from("deliverability_inboxes")
        .select("id, email, domain")
        .eq("instance", instance)
        .in("domain", domains);
      if (error) throw new Error(error.message);
      for (const r of (data || []) as { id: number; email: string | null; domain: string }[]) {
        inboxes.push({ ...r, instance });
      }
    }

    if (inboxes.length === 0) {
      // No inboxes — just drop the domain rows in scope.
      let domainsDeleted = 0;
      for (const instance of instances) {
        const { count } = await supabase
          .from("deliverability_domains")
          .select("domain", { count: "exact", head: true })
          .eq("instance", instance)
          .in("domain", domains);
        await supabase.from("deliverability_domains").delete().eq("instance", instance).in("domain", domains);
        domainsDeleted += count ?? 0;
      }
      return NextResponse.json({ success: true, inboxesDeleted: 0, notFound: 0, failed: 0, failures: [], domainsDeleted, instances });
    }

    // 2. Delete from Bison — patient retry, classified outcomes.
    const removedIds = new Map<BisonInstanceSlug, number[]>(); // deleted + not_found → remove from LeadSync
    const failures: Failure[] = [];
    let deletedCount = 0;
    let notFoundCount = 0;

    for (let i = 0; i < inboxes.length; i += DELETE_CONC) {
      const batch = inboxes.slice(i, i + DELETE_CONC);
      const results = await Promise.all(batch.map(async (inbox) => ({
        inbox,
        result: await deleteSenderEmail(inbox.instance, inbox.id),
      })));
      for (const { inbox, result } of results) {
        if (result.outcome === "failed") {
          failures.push({
            id: inbox.id,
            email: inbox.email || `#${inbox.id}`,
            domain: inbox.domain,
            instance: inbox.instance,
            status: result.status,
            error: result.error,
          });
          continue;
        }
        if (result.outcome === "deleted") deletedCount++;
        else notFoundCount++;
        (removedIds.get(inbox.instance) ?? removedIds.set(inbox.instance, []).get(inbox.instance)!).push(inbox.id);
      }
    }

    // 3. Remove the gone inboxes from LeadSync (per instance).
    for (const [instance, ids] of removedIds) {
      for (let i = 0; i < ids.length; i += 500) {
        await supabase
          .from("deliverability_inboxes")
          .delete()
          .eq("instance", instance)
          .in("id", ids.slice(i, i + 500));
      }
    }

    // 4. Reconcile each affected (instance, domain).
    let domainsDeleted = 0;
    const touched = new Set(inboxes.map((r) => `${r.instance}:${r.domain}`));
    for (const key of touched) {
      const [instance, domain] = key.split(/:(.+)/) as [BisonInstanceSlug, string];
      if (await reconcileDomain(instance, domain)) domainsDeleted++;
    }

    return NextResponse.json({
      success: true,
      inboxesDeleted: deletedCount,
      notFound: notFoundCount,
      domainsDeleted,
      failed: failures.length,
      failures: failures.slice(0, 200),
      failuresTruncated: failures.length > 200,
      instances,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
