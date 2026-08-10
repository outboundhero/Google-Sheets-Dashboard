import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import { isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";
import { isUsCaTimezone } from "@/lib/campaigns/timezones";
import { logCampaignEvent } from "@/lib/campaigns/duplication";

// POST /api/campaigns/schedule — bulk edit start/end time + timezone on the
// selected campaigns. Only fields the user set are changed; days-of-week are
// preserved per campaign. Non-US/CA timezones are skipped unless includeLocked.
// Applies via PUT /campaigns/{id}/schedule (confirmed in the Phase-0 spike).
export const maxDuration = 120;
const CONCURRENCY = 5;
const DEFAULT_DAYS = { monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false };

interface Item { instance: string; id: number }
interface Body { items?: Item[]; start_time?: string; end_time?: string; timezone?: string; includeLocked?: boolean }
type Res = { instance: string; id: number; status: "ok" | "failed" | "skipped"; reason?: string };

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Body;
    const items = (body.items || []).filter((i) => i && isInstanceSlug(i.instance) && i.id).slice(0, 500);
    if (items.length === 0) return NextResponse.json({ error: "no items" }, { status: 400 });
    const newStart = body.start_time?.trim() || null;
    const newEnd = body.end_time?.trim() || null;
    const newTz = body.timezone?.trim() || null;
    if (!newStart && !newEnd && !newTz) return NextResponse.json({ error: "nothing to change" }, { status: 400 });

    const supabase = getSupabaseAdmin();
    // Load each campaign's current schedule (to preserve days + fill unchanged fields).
    const byKey = new Map<string, { start: string | null; end: string | null; tz: string | null; days: Record<string, boolean> | null; name: string }>();
    for (let i = 0; i < items.length; i += 200) {
      const slice = items.slice(i, i + 200);
      const { data } = await supabase.from("campaigns")
        .select("id, instance, name, sched_start_time, sched_end_time, sched_timezone, sched_days")
        .in("id", slice.map((s) => s.id));
      for (const r of data || []) byKey.set(`${r.instance}:${r.id}`, { start: r.sched_start_time, end: r.sched_end_time, tz: r.sched_timezone, days: r.sched_days, name: r.name });
    }

    const results: Res[] = [];
    const applyOne = async (it: Item): Promise<Res> => {
      const cur = byKey.get(`${it.instance}:${it.id}`);
      const curTz = cur?.tz ?? null;
      if (curTz && !isUsCaTimezone(curTz) && !body.includeLocked) return { ...it, status: "skipped", reason: `locked (non-US/CA: ${curTz})` };
      const start = newStart || cur?.start || null;
      const end = newEnd || cur?.end || null;
      const tz = newTz || cur?.tz || null;
      if (!start || !end || !tz) return { ...it, status: "skipped", reason: "no existing schedule to base on — set all fields" };
      const days = cur?.days ?? DEFAULT_DAYS;
      const payload = { ...days, start_time: start, end_time: end, timezone: tz, save_as_template: false };
      try {
        const res = await bisonFetch(it.instance as BisonInstanceSlug, `/campaigns/${it.id}/schedule`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
        });
        if (!res.ok) { const t = await res.text().catch(() => ""); return { ...it, status: "failed", reason: `Bison ${res.status}: ${t.slice(0, 100)}` }; }
        await supabase.from("campaigns").update({ sched_start_time: start, sched_end_time: end, sched_timezone: tz, schedule_synced_at: new Date().toISOString() }).eq("instance", it.instance).eq("id", it.id);
        await logCampaignEvent(supabase, { instance: it.instance, campaignId: it.id, eventType: "schedule_updated", detail: `Schedule → ${start}–${end} ${tz}`, actor: "user", meta: { start, end, tz } });
        return { ...it, status: "ok" };
      } catch (e) {
        return { ...it, status: "failed", reason: e instanceof Error ? e.message : "error" };
      }
    };

    for (let i = 0; i < items.length; i += CONCURRENCY) {
      const batch = items.slice(i, i + CONCURRENCY);
      results.push(...await Promise.all(batch.map(applyOne)));
    }

    return NextResponse.json({
      results,
      ok: results.filter((r) => r.status === "ok").length,
      failed: results.filter((r) => r.status === "failed").length,
      skipped: results.filter((r) => r.status === "skipped").length,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
