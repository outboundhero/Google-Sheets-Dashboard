import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import { isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";
import { countCampaignSenders } from "@/lib/campaigns/sender-count";

export const maxDuration = 60;

// POST /api/campaigns/refresh-senders
// Body: { items: { instance, id }[] }
//
// On-demand, REAL-TIME reconcile of the sender-account count (and send schedule)
// for a specific set of campaigns — straight from Bison, right now. The grid's
// Refresh button calls this for whatever's currently in view, so counts reflect
// senders that were just attached instead of waiting for the rolling daily
// enrichment cron. Scope is bounded so a click can never fan out to thousands of
// Bison calls; filter to a client tag / stage and the whole batch is tiny.

const MAX_ITEMS = 150;
const CONCURRENCY = 6;
const BUDGET_MS = 50_000;

interface Item { instance: BisonInstanceSlug; id: number }

// One campaign → live sender count + schedule, written back to Supabase.
async function refreshOne(r: Item): Promise<{ instance: string; id: number; sender_count: number | null } | null> {
  const supabase = getSupabaseAdmin();
  let sched: Record<string, unknown> | null = null;
  // True attached-sender count via page-walk (meta.total under-reports here).
  const senderCount = await countCampaignSenders(r.instance, r.id);
  if (senderCount === null) return null; // couldn't read senders → don't overwrite with a guess
  try {
    const schedRes = await bisonFetch(r.instance, `/campaigns/${r.id}/schedule`);
    if (schedRes.ok) {
      const j = await schedRes.json().catch(() => null);
      sched = (j?.data as Record<string, unknown>) ?? null;
    }
  } catch {
    /* schedule optional — keep the sender count we already have */
  }

  const days = sched
    ? { monday: !!sched.monday, tuesday: !!sched.tuesday, wednesday: !!sched.wednesday, thursday: !!sched.thursday, friday: !!sched.friday, saturday: !!sched.saturday, sunday: !!sched.sunday }
    : undefined;

  const update: Record<string, unknown> = { sender_count: senderCount, schedule_synced_at: new Date().toISOString() };
  if (sched) {
    update.sched_start_time = (sched.start_time as string) ?? null;
    update.sched_end_time = (sched.end_time as string) ?? null;
    update.sched_timezone = (sched.timezone as string) ?? null;
    update.sched_days = days;
  }

  const { error } = await supabase.from("campaigns").update(update).eq("instance", r.instance).eq("id", r.id);
  if (error) return null;
  return { instance: r.instance, id: r.id, sender_count: senderCount };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { items?: { instance?: string; id?: number }[] };
    const raw = Array.isArray(body.items) ? body.items : [];
    // Validate + de-dupe, keep only real instance slugs and numeric ids.
    const seen = new Set<string>();
    const items: Item[] = [];
    for (const it of raw) {
      const id = Number(it?.id);
      if (!it?.instance || !isInstanceSlug(it.instance) || !Number.isFinite(id)) continue;
      const key = `${it.instance}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ instance: it.instance, id });
    }
    if (items.length === 0) return NextResponse.json({ updated: [], refreshed: 0, requested: raw.length, capped: 0 });

    const capped = Math.max(0, items.length - MAX_ITEMS);
    const work = items.slice(0, MAX_ITEMS);

    const t0 = Date.now();
    const updated: { instance: string; id: number; sender_count: number | null }[] = [];
    for (let i = 0; i < work.length && Date.now() - t0 < BUDGET_MS; i += CONCURRENCY) {
      const batch = work.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map((r) => refreshOne(r)));
      for (const res of results) if (res.status === "fulfilled" && res.value) updated.push(res.value);
    }

    return NextResponse.json({ updated, refreshed: updated.length, requested: items.length, capped });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
