import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch, resolveInstance } from "@/lib/bison";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

async function deleteSenderEmail(instance: BisonInstanceSlug, id: number): Promise<boolean> {
  try {
    const res = await bisonFetch(instance, `/sender-emails/${id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
    });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const instance = resolveInstance(searchParams.get("instance"));
    const { domains } = (await request.json()) as { domains: string[] };
    if (!domains?.length) {
      return NextResponse.json({ error: "domains required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();

    // 1. Get all inbox IDs for the selected domains (scoped to this instance)
    const { data: inboxes, error: inboxError } = await supabase
      .from("deliverability_inboxes")
      .select("id, domain")
      .eq("instance", instance)
      .in("domain", domains);

    if (inboxError) throw new Error(inboxError.message);
    if (!inboxes || inboxes.length === 0) {
      // No inboxes — just delete the domain records
      await supabase
        .from("deliverability_domains")
        .delete()
        .eq("instance", instance)
        .in("domain", domains);
      return NextResponse.json({ success: true, inboxesDeleted: 0, domainsDeleted: domains.length });
    }

    // 2. Delete from EmailBison first — 20 concurrent for speed
    const BATCH_SIZE = 20;
    const deletedIds: number[] = [];
    const failedIds: number[] = [];

    for (let i = 0; i < inboxes.length; i += BATCH_SIZE) {
      const batch = inboxes.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (inbox) => ({
          id: inbox.id,
          ok: await deleteSenderEmail(instance, inbox.id),
        }))
      );

      for (const r of results) {
        if (r.ok) deletedIds.push(r.id);
        else failedIds.push(r.id);
      }
    }

    // 3. Only delete from Supabase the inboxes that were successfully deleted from EmailBison
    if (deletedIds.length > 0) {
      await supabase
        .from("deliverability_inboxes")
        .delete()
        .eq("instance", instance)
        .in("id", deletedIds);
    }

    // 4. For each affected domain, check if all inboxes are gone (within this instance)
    const domainsDeleted: string[] = [];
    for (const domain of domains) {
      const { count } = await supabase
        .from("deliverability_inboxes")
        .select("id", { count: "exact", head: true })
        .eq("instance", instance)
        .eq("domain", domain);

      if (count === 0) {
        // All inboxes deleted — remove the domain record
        await supabase
          .from("deliverability_domains")
          .delete()
          .eq("instance", instance)
          .eq("domain", domain);
        domainsDeleted.push(domain);
      } else {
        // Some inboxes remain — re-aggregate domain stats
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
      }
    }

    return NextResponse.json({
      success: true,
      inboxesDeleted: deletedIds.length,
      domainsDeleted: domainsDeleted.length,
      failed: failedIds.length,
      instance,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
