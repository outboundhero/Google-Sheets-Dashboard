import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import { logEvents } from "@/lib/replacement/store";
import { ALL_INSTANCE_SLUGS, type BisonInstanceSlug } from "@/lib/bison-instances";
import { getOffboardedClientTags, isOffboardedTagName } from "@/lib/offboarded-tags";
import { loadGoLiveGate, goLiveCleared } from "@/lib/replacement/go-live-gate";

export const maxDuration = 300;

// GET /api/cron/revive-completed — a finished campaign that still has leads
// waiting gets pause → resume so it can send to them (Spencer's Loom
// 2026-09-16: "if a campaign goes into completed state and it was mapped as a
// main or nurture campaign, take it out of completed, put it into paused and
// resume it… otherwise we keep adding leads and it never sends to them").
// Vicky approved 2026-09-23.
//
// Deliberately narrow, because LeadSync starting a campaign is exactly what
// Nick flagged twice this week:
//   * the client's Go Live Date on the Client Tracker must have arrived — a
//     client with no date, or a future one, is never touched (Vicky
//     2026-09-23: "NEVER launch a campaign before its live date")
//   * only campaigns LIVE-confirmed as `completed` — never draft, queued,
//     archived, or a campaign a human paused
//   * only a mapped Main / Nurture N campaign of a non-churned client
//   * only when leads are actually waiting (total_leads > contacted)
//   * every status change is logged as an event with the campaign name
// A pause that cannot be resumed is retried on the next run and reported, so a
// campaign can never be left parked by us.
//
// ?dry=1 previews · ?tag= limits to one client · ?limit= caps the run.

const REVIVABLE_STAGE = /^(main|nurture \d+)$/i;
const RUN_CAP = 25;
const BUDGET_MS = 240_000;
const SETTLE_MS = 1_500;

interface Row { id: number; instance: BisonInstanceSlug; name: string; client_tag: string | null; stage: string | null; status: string }
interface LiveCampaign { status?: string; total_leads?: number; total_leads_contacted?: number }

async function liveCampaign(instance: BisonInstanceSlug, id: number): Promise<LiveCampaign | null> {
  try {
    const res = await bisonFetch(instance, `/campaigns/${id}`);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: LiveCampaign };
    return json?.data ?? null;
  } catch { return null; }
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  try {
    const params = new URL(request.url).searchParams;
    const dryRun = params.get("dry") === "1";
    const onlyTag = (params.get("tag") || "").trim().toUpperCase() || null;
    const cap = Math.max(1, Math.min(100, Number(params.get("limit") ?? RUN_CAP) || RUN_CAP));

    const supabase = getSupabaseAdmin();
    // Fail CLOSED: if the tracker cannot be read we revive nothing this run,
    // rather than risk starting a campaign before its go-live date.
    const [offboarded, goLive] = await Promise.all([getOffboardedClientTags(), loadGoLiveGate()]);

    // Candidates from the mirror; every one is re-checked live before we touch it.
    const rows: Row[] = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase
        .from("campaigns").select("id, instance, name, client_tag, stage, status")
        .in("instance", ALL_INSTANCE_SLUGS).order("id", { ascending: true }).range(off, off + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      for (const c of data as Row[]) {
        const tag = (c.client_tag || "").trim().toUpperCase();
        if (!tag || (onlyTag && tag !== onlyTag)) continue;
        if (isOffboardedTagName(tag, offboarded)) continue;
        if (!REVIVABLE_STAGE.test(String(c.stage || ""))) continue;
        // Paused rows are included so a half-finished revive from an earlier
        // run (pause landed, resume did not) gets picked back up.
        const st = String(c.status || "").toLowerCase();
        if (st !== "completed" && st !== "paused") continue;
        rows.push(c);
      }
      if (data.length < 1000) break;
    }

    interface Result { instance: string; id: number; name: string; tag: string; action: string; detail: string; leadsWaiting?: number }
    const results: Result[] = [];
    let revived = 0;
    let budgetHit = false;

    for (const c of rows) {
      if (revived >= cap) break;
      if (Date.now() - startedAt > BUDGET_MS) { budgetHit = true; break; }
      const tag = (c.client_tag || "").trim().toUpperCase();

      const gate = goLiveCleared(tag, goLive);
      if (!gate.cleared) {
        results.push({ instance: c.instance, id: c.id, name: c.name, tag, action: "skip", detail: gate.reason ?? "not cleared to go live" });
        continue;
      }

      const live = await liveCampaign(c.instance, c.id);
      if (!live) { results.push({ instance: c.instance, id: c.id, name: c.name, tag, action: "skip", detail: "could not read live status" }); continue; }
      const liveStatus = String(live.status || "").toLowerCase();

      // A paused candidate only matters if WE left it paused mid-revive; a
      // human's pause has leads waiting too, so the mirror alone cannot tell
      // them apart. Only resume a paused campaign when the mirror still says
      // completed — i.e. our own pause that Bison has already applied.
      const ourHalfDone = liveStatus === "paused" && String(c.status || "").toLowerCase() === "completed";
      if (liveStatus !== "completed" && !ourHalfDone) {
        results.push({ instance: c.instance, id: c.id, name: c.name, tag, action: "skip", detail: `live status is ${liveStatus || "unknown"} — not completed` });
        continue;
      }

      const waiting = Math.max(0, (live.total_leads ?? 0) - (live.total_leads_contacted ?? 0));
      if (waiting === 0) {
        results.push({ instance: c.instance, id: c.id, name: c.name, tag, action: "skip", detail: "completed with no leads waiting — nothing to send", leadsWaiting: 0 });
        continue;
      }

      if (dryRun) {
        results.push({ instance: c.instance, id: c.id, name: c.name, tag, action: "would-revive", detail: ourHalfDone ? "resume only (already paused by us)" : "pause → resume", leadsWaiting: waiting });
        revived++;
        continue;
      }

      if (!ourHalfDone) {
        const p = await bisonFetch(c.instance, `/campaigns/${c.id}/pause`, { method: "PATCH" });
        if (!p.ok) {
          const t = await p.text().catch(() => "");
          results.push({ instance: c.instance, id: c.id, name: c.name, tag, action: "failed", detail: `pause HTTP ${p.status} ${t.slice(0, 120)}`, leadsWaiting: waiting });
          await logEvents([{ instance: c.instance, clientTag: tag, eventType: "error", detail: `revive-completed: could not pause "${c.name}" — HTTP ${p.status}`, signals: { kind: "revive_completed", campaignId: c.id, step: "pause" } }]).catch(() => undefined);
          continue;
        }
        await new Promise((r) => setTimeout(r, SETTLE_MS));
      }

      const r = await bisonFetch(c.instance, `/campaigns/${c.id}/resume`, { method: "PATCH" });
      const after = await liveCampaign(c.instance, c.id);
      const afterStatus = String(after?.status || "").toLowerCase();
      if (!r.ok || (afterStatus && afterStatus !== "active")) {
        const t = r.ok ? "" : await r.text().catch(() => "");
        results.push({ instance: c.instance, id: c.id, name: c.name, tag, action: "failed", detail: `resume ${r.ok ? `left it ${afterStatus}` : `HTTP ${r.status} ${t.slice(0, 120)}`} — retried next run`, leadsWaiting: waiting });
        await logEvents([{ instance: c.instance, clientTag: tag, eventType: "error", detail: `revive-completed: "${c.name}" is paused and did not resume (${r.ok ? afterStatus : `HTTP ${r.status}`}) — will retry`, signals: { kind: "revive_completed", campaignId: c.id, step: "resume" } }]).catch(() => undefined);
        continue;
      }

      revived++;
      results.push({ instance: c.instance, id: c.id, name: c.name, tag, action: "revived", detail: `completed → active (${waiting} leads waiting)`, leadsWaiting: waiting });
      await supabase.from("campaigns").update({ status: "active" }).eq("instance", c.instance).eq("id", c.id);
      await logEvents([{
        instance: c.instance, clientTag: tag, eventType: "proposed",
        detail: `revive-completed: "${c.name}" was completed with ${waiting} leads waiting — paused and resumed`,
        signals: { kind: "revive_completed", campaignId: c.id, stage: c.stage, leadsWaiting: waiting },
      }]).catch(() => undefined);
    }

    if (!dryRun) {
      await logEvents([{
        eventType: "proposed",
        detail: `revive-completed run: ${results.filter((x) => x.action === "revived").length} revived · ${results.filter((x) => x.action === "failed").length} failed · ${results.filter((x) => x.action === "skip").length} skipped · ${Math.round((Date.now() - startedAt) / 1000)}s${budgetHit ? " · budget hit" : ""}`,
        signals: { kind: "revive_completed_run", budgetHit, revived: results.filter((x) => x.action === "revived").length },
      }]).catch(() => undefined);
    }

    return NextResponse.json({
      dryRun, budgetHit, candidates: rows.length,
      revived: results.filter((x) => x.action === "revived" || x.action === "would-revive").length,
      failed: results.filter((x) => x.action === "failed").length,
      results: results.filter((x) => x.action !== "skip" || x.detail.includes("live status")),
      skippedCount: results.filter((x) => x.action === "skip").length,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "revive-completed failed" }, { status: 500 });
  }
}
