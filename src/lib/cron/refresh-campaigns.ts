import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import { ALL_INSTANCE_SLUGS, type BisonInstanceSlug } from "@/lib/bison-instances";
import { runCampaignsSync } from "./sync-campaigns";
import { recordPipelineAlert, resolveAlertsForClients } from "@/lib/pipeline-alerts";

// The daily 12pm-PT campaigns reconcile:
//   1. Full list-level sync of all 4 instances (counters, stage, first_sending_at).
//   2. Bounded per-campaign ENRICHMENT — schedule (send window + timezone) and
//      sender-inbox count — for campaigns whose enrichment is missing/stale
//      (oldest first), so the grid can show schedule + senders "without opening
//      the campaign". Bounded by count + wall-clock so it never overruns.
// Connection/count failures surface via the existing pipeline-alerts banner.

const ENRICH_LIMIT = 400;
const CONCURRENCY = 6;
const BUDGET_MS = 240_000;
const STALE_MS = 20 * 3600_000;

interface DueRow { id: number; instance: BisonInstanceSlug }

export async function runCampaignsRefresh(): Promise<{ synced: Record<string, number | string>; enriched: number; enrichFailed: number; durationMs: number }> {
  const t0 = Date.now();
  const supabase = getSupabaseAdmin();

  // 1. List-level sync for every instance.
  const synced: Record<string, number | string> = {};
  for (const slug of ALL_INSTANCE_SLUGS) {
    try {
      const res = await runCampaignsSync(slug);
      synced[slug] = res.status;
      if (res.status >= 400) {
        await recordPipelineAlert({ source: "campaigns-sync", clientTag: slug, step: "sync", reason: `Bison campaign sync failed (HTTP ${res.status})` });
      } else {
        await resolveAlertsForClients("campaigns-sync", [slug]);
      }
    } catch (e) {
      synced[slug] = "error";
      await recordPipelineAlert({ source: "campaigns-sync", clientTag: slug, step: "sync", reason: e instanceof Error ? e.message : "sync error" });
    }
  }

  // 2. Enrichment — pick campaigns needing schedule/sender refresh (oldest first).
  const cutoff = new Date(Date.now() - STALE_MS).toISOString();
  const { data: due } = await supabase
    .from("campaigns")
    .select("id, instance, schedule_synced_at")
    .or(`schedule_synced_at.is.null,schedule_synced_at.lt.${cutoff}`)
    .order("schedule_synced_at", { ascending: true, nullsFirst: true })
    .limit(ENRICH_LIMIT);

  const rows = (due || []) as DueRow[];
  let enriched = 0, enrichFailed = 0;
  for (let i = 0; i < rows.length && Date.now() - t0 < BUDGET_MS; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map((r) => enrichOne(r)));
    for (const res of results) { if (res.status === "fulfilled" && res.value) enriched++; else enrichFailed++; }
  }

  const durationMs = Date.now() - t0;
  console.log(`[cron/campaigns-refresh] synced=${JSON.stringify(synced)} enriched=${enriched} failed=${enrichFailed} due=${rows.length} duration=${durationMs}ms`);
  return { synced, enriched, enrichFailed, durationMs };
}

async function enrichOne(r: DueRow): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  let sched: Record<string, unknown> | null = null;
  let senderCount: number | null = null;
  try {
    const [schedRes, sendRes] = await Promise.allSettled([
      bisonFetch(r.instance, `/campaigns/${r.id}/schedule`),
      bisonFetch(r.instance, `/campaigns/${r.id}/sender-emails?per_page=1&page=1`),
    ]);
    if (schedRes.status === "fulfilled" && schedRes.value.ok) {
      const j = await schedRes.value.json().catch(() => null);
      sched = (j?.data as Record<string, unknown>) ?? null;
    }
    if (sendRes.status === "fulfilled" && sendRes.value.ok) {
      const j = await sendRes.value.json().catch(() => null);
      senderCount = (j?.meta?.total as number) ?? (Array.isArray(j?.data) ? j.data.length : null);
    }
  } catch { /* leave nulls; still stamp so we don't hot-loop this row */ }

  const days = sched
    ? { monday: !!sched.monday, tuesday: !!sched.tuesday, wednesday: !!sched.wednesday, thursday: !!sched.thursday, friday: !!sched.friday, saturday: !!sched.saturday, sunday: !!sched.sunday }
    : null;

  const { error } = await supabase
    .from("campaigns")
    .update({
      sched_start_time: (sched?.start_time as string) ?? null,
      sched_end_time: (sched?.end_time as string) ?? null,
      sched_timezone: (sched?.timezone as string) ?? null,
      sched_days: days,
      sender_count: senderCount,
      schedule_synced_at: new Date().toISOString(),
    })
    .eq("instance", r.instance)
    .eq("id", r.id);
  return !error;
}
