import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { isInstanceSlug } from "@/lib/bison-instances";
import { deleteDomainFromInstance } from "@/lib/deliverability/delete-domain";

// Executor for the duplicate-domains "Remove + schedule delete" flow. When a
// domain is scheduled, the card detaches its senders from that instance's
// campaigns NOW and writes a `duplicate_domain_deletions` row with
// scheduled_at = now + 4-day grace, status = 'pending'. THIS cron is what
// actually fires the deletion once the grace has elapsed — without it the
// scheduled rows just sat there forever.
//
// Each due row runs through deleteDomainFromInstance(), which verifies against
// Bison and sweeps until zero senders remain. On a fully-clean delete the row
// is marked 'done'; if anything is still stuck it stays 'pending' and the next
// daily run retries it (the delete is idempotent).

const MAX_PER_RUN = 25; // stay comfortably inside maxDuration; overflow waits for the next daily run

export async function runScheduledDeletions(): Promise<NextResponse> {
  const supabase = getSupabaseAdmin();
  const nowIso = new Date().toISOString();

  const { data: due, error } = await supabase
    .from("duplicate_domain_deletions")
    .select("instance, domain, scheduled_at, status")
    .eq("status", "pending")
    .lte("scheduled_at", nowIso)
    .order("scheduled_at", { ascending: true })
    .limit(MAX_PER_RUN);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (due || []) as { instance: string; domain: string }[];
  const results: { instance: string; domain: string; deleted: number; notFound: number; failed: number; remainingInBison: number; done: boolean }[] = [];

  for (const row of rows) {
    if (!isInstanceSlug(row.instance)) {
      // Unknown instance slug — mark done so it doesn't loop forever.
      await supabase.from("duplicate_domain_deletions").update({ status: "done" }).eq("instance", row.instance).eq("domain", row.domain);
      continue;
    }
    try {
      const r = await deleteDomainFromInstance(row.instance, row.domain);
      const done = r.remainingInBison === 0 && r.failed === 0;
      if (done) {
        await supabase.from("duplicate_domain_deletions").update({ status: "done" }).eq("instance", row.instance).eq("domain", row.domain);
      }
      results.push({ instance: row.instance, domain: row.domain, deleted: r.inboxesDeleted, notFound: r.notFound, failed: r.failed, remainingInBison: r.remainingInBison, done });
    } catch (e) {
      // Leave pending → retried next run.
      console.error(`[cron/fire-scheduled-deletions] ${row.instance}:${row.domain} failed:`, e instanceof Error ? e.message : e);
      results.push({ instance: row.instance, domain: row.domain, deleted: 0, notFound: 0, failed: 1, remainingInBison: -1, done: false });
    }
  }

  const fired = results.filter((r) => r.done).length;
  console.log(`[cron/fire-scheduled-deletions] due=${rows.length} completed=${fired} retryNext=${rows.length - fired}`);
  return NextResponse.json({ due: rows.length, completed: fired, retryNext: rows.length - fired, results });
}
