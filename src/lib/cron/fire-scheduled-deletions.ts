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

const MAX_PER_RUN = 15; // stay comfortably inside maxDuration; overflow waits for the next run
// Hard guarantee against Vercel's 300s FUNCTION_INVOCATION_TIMEOUT (which returns
// an HTML 504 — no JSON, no per-row progress banked, exactly the "still stuck"
// symptom): never START a row after RUN_BUDGET_MS, and cap any single row at
// ROW_TIMEOUT_MS. Worst case = start at 139.9s + run 130s = ~270s < 300s.
const RUN_BUDGET_MS = 140_000; // don't start a new row past this — leaves room for one full ROW_TIMEOUT_MS row + the trailing count query
const ROW_TIMEOUT_MS = 130_000; // a row beyond this is wedged (or on a very slow instance) — rotate it to the back; its deletes usually already landed, so the requeued retry verifies-clean fast
const REQUEUE_DELAY_MS = 6 * 3600_000;

// Any row that didn't fully complete rotates to the back (+6h) instead of
// re-heading the oldest-first queue — one wedged domain can otherwise starve
// everything behind it forever, which is exactly how the queue sat frozen
// with zero progress for 6 days (Jul 25–31).
async function requeueToBack(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  row: { instance: string; domain: string },
): Promise<void> {
  await supabase
    .from("duplicate_domain_deletions")
    .update({ scheduled_at: new Date(Date.now() + REQUEUE_DELAY_MS).toISOString() })
    .eq("instance", row.instance)
    .eq("domain", row.domain);
}

export async function runScheduledDeletions(limit = MAX_PER_RUN): Promise<NextResponse> {
  const supabase = getSupabaseAdmin();
  const nowIso = new Date().toISOString();

  const { data: due, error } = await supabase
    .from("duplicate_domain_deletions")
    .select("instance, domain, scheduled_at, status")
    .eq("status", "pending")
    .lte("scheduled_at", nowIso)
    .order("scheduled_at", { ascending: true })
    .limit(limit);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (due || []) as { instance: string; domain: string }[];
  const results: { instance: string; domain: string; deleted: number; notFound: number; failed: number; remainingInBison: number; done: boolean; error?: string }[] = [];

  const startedAt = Date.now();
  for (const row of rows) {
    if (Date.now() - startedAt > RUN_BUDGET_MS) break; // bank what finished; next run continues from here
    if (!isInstanceSlug(row.instance)) {
      // Unknown instance slug — mark done so it doesn't loop forever.
      await supabase.from("duplicate_domain_deletions").update({ status: "done" }).eq("instance", row.instance).eq("domain", row.domain);
      continue;
    }
    try {
      const r = await Promise.race([
        deleteDomainFromInstance(row.instance, row.domain),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`row timeout after ${ROW_TIMEOUT_MS / 1000}s`)), ROW_TIMEOUT_MS)),
      ]);
      const done = r.remainingInBison === 0 && r.failed === 0;
      if (done) {
        await supabase.from("duplicate_domain_deletions").update({ status: "done" }).eq("instance", row.instance).eq("domain", row.domain);
      } else {
        await requeueToBack(supabase, row);
      }
      results.push({ instance: row.instance, domain: row.domain, deleted: r.inboxesDeleted, notFound: r.notFound, failed: r.failed, remainingInBison: r.remainingInBison, done });
    } catch (e) {
      await requeueToBack(supabase, row);
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[cron/fire-scheduled-deletions] ${row.instance}:${row.domain} failed:`, msg);
      results.push({ instance: row.instance, domain: row.domain, deleted: 0, notFound: 0, failed: 1, remainingInBison: -1, done: false, error: msg.slice(0, 200) });
    }
  }

  const fired = results.filter((r) => r.done).length;

  // How many pending rows are still due (past their grace) after this batch —
  // lets a manual runner loop until the backlog is drained.
  const { count: dueRemaining } = await supabase
    .from("duplicate_domain_deletions")
    .select("instance", { count: "exact", head: true })
    .eq("status", "pending")
    .lte("scheduled_at", new Date().toISOString());

  console.log(`[cron/fire-scheduled-deletions] due=${rows.length} completed=${fired} retryNext=${rows.length - fired} dueRemaining=${dueRemaining ?? 0}`);
  return NextResponse.json({ due: rows.length, completed: fired, retryNext: rows.length - fired, dueRemaining: dueRemaining ?? 0, results });
}
