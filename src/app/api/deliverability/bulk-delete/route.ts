import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { resolveInstances } from "@/lib/bison";
import { deleteDomainFromInstance, type DeleteFailure } from "@/lib/deliverability/delete-domain";

export const maxDuration = 300;

/**
 * POST /api/deliverability/bulk-delete?instances=<csv>
 *
 * Deletes the given domains' inboxes from their Bison instance(s) + LeadSync.
 * The dialog drives this one domain per request (Vercel-timeout-safe).
 *
 * The heavy lifting lives in `deleteDomainFromInstance()` — it takes the UNION
 * of Supabase's inbox rows and a LIVE Bison `?search=<domain>` lookup (so
 * senders that were never synced still get deleted — the "1–2 inboxes remain
 * in Bison" bug), deletes each with patient retry, then RE-QUERIES Bison and
 * sweeps again until nothing is left. Only when Bison reports zero senders for
 * the domain do we drop the whole (instance, domain) footprint from LeadSync.
 *
 * Second action — { action: "purge", domains } — removes the domains' rows
 * from LeadSync WITHOUT touching Bison: the escape hatch for inboxes Bison
 * persistently refuses to delete/identify.
 *
 * Admin-only via middleware (POST).
 */

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
        await supabase.from("deliverability_domain_carryover").delete().eq("instance", instance).in("domain", domains);
        inboxRows += count ?? 0;
        domainRows += dCount ?? 0;
      }
      return NextResponse.json({ success: true, purged: true, inboxRows, domainRows });
    }

    // ── Delete from Bison + LeadSync (authoritative, Bison-verified) ───────
    // Every scoped instance × every requested domain runs through the shared
    // deleter, which guarantees no sender survives (or reports what stuck).
    const failures: DeleteFailure[] = [];
    let deletedCount = 0;
    let notFoundCount = 0;
    let domainsDeleted = 0;

    for (const instance of instances) {
      for (const domain of domains) {
        const r = await deleteDomainFromInstance(instance, domain);
        deletedCount += r.inboxesDeleted;
        notFoundCount += r.notFound;
        failures.push(...r.failures);
        if (r.domainRowRemoved) domainsDeleted++;
      }
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
