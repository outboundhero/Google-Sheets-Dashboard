import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { isInstanceSlug } from "@/lib/bison-instances";
import { deleteDomainFromInstance } from "@/lib/deliverability/delete-domain";
import { logEvents } from "@/lib/replacement/store";

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

const MAX_PER_RUN = 40; // pulled per run, split into per-instance lanes below
const LANE_MAX = 12;    // cap per lane; the shared budget cuts a run off anyway
// Budgets sized for the routes' 800s Fluid maxDuration, never START a row past
// RUN_BUDGET_MS, and cap any single row at ROW_TIMEOUT_MS (worst case ~600s +
// 260s is still under 800s + the trailing count query). The previous 140s/130s
// pair was sized for a 300s function and was far too tight for facilityreach,
// where ONE rate-limited sender search can burn ~60s: rows died on "row timeout
// after 130s" having deleted nothing, requeued +6h, and repeated forever.
// 2026-09-04 starvation fix: a 48-sender facilityreach domain needs search
// (≤45s) + deletes + final verify (≤150s), which the old 260s ceiling cut off
// every attempt — rows then sat 6h and the backlog aged for days. Give a row
// the room to actually finish inside one attempt.
const RUN_BUDGET_MS = 700_000;
const ROW_TIMEOUT_MS = 420_000;
const REQUEUE_DELAY_MS = 6 * 3600_000;
// A row whose deletes ran but whose verification was throttled comes back in
// minutes, not 6 hours — it's usually one clean re-verify away from done.
const REQUEUE_SOON_MS = 20 * 60_000;

// Any row that didn't fully complete rotates to the back (+6h) instead of
// re-heading the oldest-first queue — one wedged domain can otherwise starve
// everything behind it forever, which is exactly how the queue sat frozen
// with zero progress for 6 days (Jul 25–31).
async function requeueToBack(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  row: { instance: string; domain: string },
  delayMs = REQUEUE_DELAY_MS,
): Promise<void> {
  await supabase
    .from("duplicate_domain_deletions")
    .update({ scheduled_at: new Date(Date.now() + delayMs).toISOString() })
    .eq("instance", row.instance)
    .eq("domain", row.domain);
}

/**
 * `force` (Spencer 2026-08-12: "can you please force these through?") ignores
 * the grace period and works the oldest pending rows regardless of
 * scheduled_at. Nothing else changes — same executor, same verification.
 */
export async function runScheduledDeletions(
  limit = MAX_PER_RUN,
  opts: { force?: boolean } = {},
): Promise<NextResponse> {
  const supabase = getSupabaseAdmin();
  const nowIso = new Date().toISOString();
  const force = opts.force === true;

  let query = supabase
    .from("duplicate_domain_deletions")
    .select("instance, domain, scheduled_at, status")
    .eq("status", "pending");
  if (!force) query = query.lte("scheduled_at", nowIso);
  const { data: due, error } = await query
    .order("scheduled_at", { ascending: true })
    .limit(limit);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (due || []) as { instance: string; domain: string }[];
  const results: { instance: string; domain: string; deleted: number; notFound: number; failed: number; remainingInBison: number; done: boolean; error?: string }[] = [];

  // Per-instance lanes (2026-09-07): one slow facilityreach row used to eat
  // the whole run's budget while dozens of fast outboundhero/outboundclean
  // rows sat behind it in the shared oldest-first queue (observed: 72 fast
  // rows starved for days). Each instance drains sequentially in its OWN lane
  // — still gentle on that workspace — and the lanes run in parallel.
  const startedAt = Date.now();
  const lanes = new Map<string, typeof rows>();
  for (const row of rows) {
    const lane = lanes.get(row.instance) ?? [];
    if (lane.length < LANE_MAX) lane.push(row);
    lanes.set(row.instance, lane);
  }
  const processRow = async (row: { instance: string; domain: string }) => {
    if (!isInstanceSlug(row.instance)) {
      // Unknown instance slug — mark done so it doesn't loop forever.
      await supabase.from("duplicate_domain_deletions").update({ status: "done" }).eq("instance", row.instance).eq("domain", row.domain);
      return;
    }
    try {
      const r = await Promise.race([
        deleteDomainFromInstance(row.instance, row.domain),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`row timeout after ${ROW_TIMEOUT_MS / 1000}s`)), ROW_TIMEOUT_MS)),
      ]);
      // "0 remaining" only counts when the verification search actually finished.
      const done = r.remainingInBison === 0 && r.failed === 0 && !r.verifyIncomplete;
      if (done) {
        await supabase.from("duplicate_domain_deletions").update({ status: "done" }).eq("instance", row.instance).eq("domain", row.domain);
        // The final, irreversible step must be in the domain's history too
        // (Spencer + Nick 2026-08-26: every action recorded with why, and
        // "confirm the final deletion actually occurred").
        await logEvents([{
          instance: row.instance,
          domain: row.domain,
          eventType: "removed",
          detail: `deleted from Bison (executor): ${r.inboxesDeleted} inbox(es) deleted, ${r.notFound} already gone — verified 0 remaining in ${row.instance}`,
        }]).catch(() => {});
      } else {
        // deletes landed but verification was throttled → come back in minutes
        const soon = r.verifyIncomplete && r.failed === 0;
        await requeueToBack(supabase, row, soon ? REQUEUE_SOON_MS : REQUEUE_DELAY_MS);
      }
      results.push({
        instance: row.instance, domain: row.domain, deleted: r.inboxesDeleted, notFound: r.notFound,
        failed: r.failed, remainingInBison: r.remainingInBison, done,
        error: done ? undefined : r.verifyIncomplete
          ? "Bison rate-limited the verification — deletes submitted, re-verifying shortly"
          : r.failures[0]?.error,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A row timeout means slow, not broken — deletes that landed persist on
      // Bison, so a quick retry resumes with fewer senders. The 6h penalty is
      // reserved for real errors.
      await requeueToBack(supabase, row, msg.includes("row timeout") ? REQUEUE_SOON_MS : REQUEUE_DELAY_MS);
      console.error(`[cron/fire-scheduled-deletions] ${row.instance}:${row.domain} failed:`, msg);
      results.push({ instance: row.instance, domain: row.domain, deleted: 0, notFound: 0, failed: 1, remainingInBison: -1, done: false, error: msg.slice(0, 200) });
    }
  };
  await Promise.all(
    [...lanes.values()].map(async (lane) => {
      for (const row of lane) {
        if (Date.now() - startedAt > RUN_BUDGET_MS) break; // bank what finished; next run continues
        await processRow(row);
      }
    }),
  );

  const fired = results.filter((r) => r.done).length;

  // How many pending rows are still due (past their grace) after this batch —
  // lets a manual runner loop until the backlog is drained.
  let remainingQuery = supabase
    .from("duplicate_domain_deletions")
    .select("instance", { count: "exact", head: true })
    .eq("status", "pending");
  if (!force) remainingQuery = remainingQuery.lte("scheduled_at", new Date().toISOString());
  const { count: dueRemaining } = await remainingQuery;

  console.log(`[cron/fire-scheduled-deletions] force=${force} due=${rows.length} completed=${fired} retryNext=${rows.length - fired} dueRemaining=${dueRemaining ?? 0}`);
  return NextResponse.json({ force, due: rows.length, completed: fired, retryNext: rows.length - fired, dueRemaining: dueRemaining ?? 0, results });
}
