import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

const API_BASE = "https://app.outboundhero.co/api";
const API_KEY = process.env.OUTBOUNDHERO_API_KEY!;
const apiHeaders = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function deleteSenderEmail(id: number): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/sender-emails/${id}`, {
      method: "DELETE",
      headers: apiHeaders,
    });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  try {
    const { domains } = (await request.json()) as { domains: string[] };
    if (!domains?.length) {
      return NextResponse.json({ error: "domains required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();

    // 1. Get all inbox IDs for the selected domains
    const { data: inboxes, error: inboxError } = await supabase
      .from("deliverability_inboxes")
      .select("id, domain")
      .in("domain", domains);

    if (inboxError) throw new Error(inboxError.message);
    if (!inboxes || inboxes.length === 0) {
      // No inboxes — just delete the domain records
      await supabase.from("deliverability_domains").delete().in("domain", domains);
      return NextResponse.json({ success: true, inboxesDeleted: 0, domainsDeleted: domains.length });
    }

    // 2. Delete from EmailBison first — track which ones succeeded
    const BATCH_SIZE = 10;
    const BATCH_DELAY = 200;
    const deletedIds: number[] = [];
    const failedIds: number[] = [];

    for (let i = 0; i < inboxes.length; i += BATCH_SIZE) {
      const batch = inboxes.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (inbox) => ({
          id: inbox.id,
          ok: await deleteSenderEmail(inbox.id),
        }))
      );

      for (const r of results) {
        if (r.ok) deletedIds.push(r.id);
        else failedIds.push(r.id);
      }

      if (i + BATCH_SIZE < inboxes.length) await delay(BATCH_DELAY);
    }

    // 3. Only delete from Supabase the inboxes that were successfully deleted from EmailBison
    if (deletedIds.length > 0) {
      await supabase
        .from("deliverability_inboxes")
        .delete()
        .in("id", deletedIds);
    }

    // 4. For each affected domain, check if all inboxes are gone
    const domainsDeleted: string[] = [];
    for (const domain of domains) {
      const { count } = await supabase
        .from("deliverability_inboxes")
        .select("id", { count: "exact", head: true })
        .eq("domain", domain);

      if (count === 0) {
        // All inboxes deleted — remove the domain record
        await supabase.from("deliverability_domains").delete().eq("domain", domain);
        domainsDeleted.push(domain);
      } else {
        // Some inboxes remain — re-aggregate domain stats
        const { data: remaining } = await supabase
          .from("deliverability_inboxes")
          .select("tags, type, emails_sent_count, total_replied_count, bounced_count")
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
            .eq("domain", domain);
        }
      }
    }

    return NextResponse.json({
      success: true,
      inboxesDeleted: deletedIds.length,
      domainsDeleted: domainsDeleted.length,
      failed: failedIds.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
