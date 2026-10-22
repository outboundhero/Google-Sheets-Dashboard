import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import { logEvents } from "@/lib/replacement/store";
import { ALL_INSTANCE_SLUGS, BISON_INSTANCES, type BisonInstanceSlug } from "@/lib/bison-instances";
import { getOffboardedClientTags, isOffboardedTagName } from "@/lib/offboarded-tags";
import { loadGoLiveGate, goLiveCleared } from "@/lib/replacement/go-live-gate";
import { deriveStage } from "@/lib/campaigns/stage";
import { recordPipelineAlert, resolveAlert } from "@/lib/pipeline-alerts";

export const maxDuration = 300;

// GET /api/cron/revive-completed — hourly. A completed Main / Nurture campaign
// that still has leads due gets pause → resume so it sends to them (Spencer's
// Loom 2026-09-16: "if a campaign goes into completed state and it was mapped
// as a main or nurture campaign, take it out of completed, put it into paused
// and resume it… otherwise we keep adding leads and it never sends to them").
// Vicky approved 2026-09-23.
//
// Rebuilt 2026-10-23 after Spencer flagged BCSOR, CWSLC and CVJLEX sitting in
// Completed. The daily version judged "leads waiting" as total_leads −
// total_leads_contacted, which was wrong both ways:
//   * it counted leads Bison has STOPPED (inbox removed from the campaign or
//     deleted, email on the blocklist) — they never send, so Bison completed
//     the campaign again within the hour and we "revived" the same 34
//     campaigns 217 times in two weeks (JPTUC 8,365 "waiting" every day);
//   * once leads move on to Nurture, contacted outgrows total and the sum
//     went to 0 — CVJLEX Google + Custom sat completed with 26 leads due.
// That churn also used up the 240s budget every day before the list ended.
// Now the signal is Bison's own count of leads still in sequence (new leads
// land there too), read live, and checked every hour.
//
// Still deliberately narrow, because LeadSync starting a campaign is exactly
// what Nick flagged:
//   * the client's Go Live Date on the Client Tracker must have arrived — a
//     client with no date, or a future one, is never touched (Vicky
//     2026-09-23: "NEVER launch a campaign before its live date")
//   * only campaigns LIVE as `completed` — never draft, queued, archived, or a
//     campaign a human paused (we only resume pauses we made ourselves)
//   * only a Main / Nurture N campaign of a non-churned client
//   * every status change is logged as an event with the campaign name
// A pause that cannot be resumed is retried on the next run, so a campaign is
// never left parked by us. Without Redis we cannot remember our own pauses, so
// nothing is paused at all.
//
// What cannot be fixed by waking goes to the dashboard (silent, clears itself):
//   * out of leads — completed with nothing due; someone has to add leads
//   * Bison won't send — woken within the last day, completed again without a
//     single email going out; not woken again until a day has passed
//
// ?dry=1 previews · ?tag= limits to one client · ?limit= caps wake-ups.

const REVIVABLE_STAGE = /^(main|nurture \d+)$/i;
const RUN_CAP = 25;
const BUDGET_MS = 240_000;
const SETTLE_MS = 1_500;
// Bison's resume is asynchronous: the campaign reports `queued` (or
// `launching`) for a few seconds before it flips to `active`. Reading the
// status immediately after the PATCH therefore logged a failure on a resume
// that had in fact worked — 18 of them on 2026-09-24, while JPCHI 1011 and
// JPCI 739 were sitting active by the time anyone looked. Poll instead.
const RESUME_VERIFY_MS = 25_000;
const RESUME_POLL_MS = 3_000;
const IN_PROGRESS = new Set(["queued", "launching", "processing"]);

const SOURCE = "campaign-completed";
// Redis hashes keyed `${instance}:${id}`.
const PAUSED_KEY = "cron:revive-completed:paused-by-us"; // → ISO time of our pause
const WOKEN_KEY = "cron:revive-completed:woken"; // → Woken
const RETRY_WAKE_MS = 24 * 3_600_000;

interface LiveCampaign { id: number; name?: string; status?: string; total_leads?: number; emails_sent?: number }
interface Candidate { instance: BisonInstanceSlug; id: number; name: string; tag: string; stage: string; status: string; totalLeads: number; emailsSent: number }
interface Woken { at: string; due: number; emailsSent: number }

function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET with a short retry on 429 / 5xx; null when Bison never answered OK. */
async function bisonGet(instance: BisonInstanceSlug, path: string): Promise<Response | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await bisonFetch(instance, path);
      if (res.ok) return res;
      if (res.status !== 429 && res.status < 500) return null;
    } catch { /* network — retry */ }
    await sleep(2_000 * (attempt + 1));
  }
  return null;
}

/** Every campaign on the instance, live — the mirror is up to 6 hours old. */
async function listCampaigns(instance: BisonInstanceSlug): Promise<LiveCampaign[] | null> {
  const all: LiveCampaign[] = [];
  for (let page = 1, last = 1; page <= last; page++) {
    const res = await bisonGet(instance, `/campaigns?page=${page}&per_page=100`);
    if (!res) return null;
    const json = (await res.json().catch(() => null)) as { data?: LiveCampaign[]; meta?: { last_page?: number } } | null;
    if (!json) return null;
    all.push(...(json.data || []));
    last = json.meta?.last_page || 1;
  }
  return all;
}

async function liveStatus(instance: BisonInstanceSlug, id: number): Promise<string> {
  const res = await bisonGet(instance, `/campaigns/${id}`);
  const json = res ? ((await res.json().catch(() => null)) as { data?: { status?: string } } | null) : null;
  return String(json?.data?.status || "").toLowerCase();
}

/** Leads Bison still has an email queued for — mid-sequence or not started
 *  yet, which is where newly added leads land. Stopped leads are not counted. */
async function dueLeads(instance: BisonInstanceSlug, id: number): Promise<number | null> {
  const res = await bisonGet(instance, `/campaigns/${id}/leads?per_page=1&filters%5Blead_campaign_status%5D=in_sequence`);
  if (!res) return null;
  const json = (await res.json().catch(() => null)) as { meta?: { total?: number } } | null;
  return typeof json?.meta?.total === "number" ? json.meta.total : null;
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  try {
    const params = new URL(request.url).searchParams;
    const dryRun = params.get("dry") === "1";
    const onlyTag = (params.get("tag") || "").trim().toUpperCase() || null;
    const cap = Math.max(1, Math.min(100, Number(params.get("limit") ?? RUN_CAP) || RUN_CAP));

    const supabase = getSupabaseAdmin();
    const redis = getRedis();
    // Fail CLOSED: if the tracker cannot be read we revive nothing this run,
    // rather than risk starting a campaign before its go-live date.
    const [offboarded, goLive] = await Promise.all([getOffboardedClientTags(), loadGoLiveGate()]);
    const [pausedByUs, woken] = redis
      ? await Promise.all([
          redis.hgetall<Record<string, string>>(PAUSED_KEY).then((v) => v ?? {}),
          redis.hgetall<Record<string, Woken>>(WOKEN_KEY).then((v) => v ?? {}),
        ])
      : [{} as Record<string, string>, {} as Record<string, Woken>];

    const candidates: Candidate[] = [];
    const listFailed: BisonInstanceSlug[] = [];
    for (const instance of ALL_INSTANCE_SLUGS) {
      const list = await listCampaigns(instance);
      if (!list) { listFailed.push(instance); continue; }
      for (const c of list) {
        const name = c.name || "";
        const colon = name.indexOf(":");
        const tag = colon > 0 ? name.slice(0, colon).trim().toUpperCase() : "";
        if (!tag || (onlyTag && tag !== onlyTag)) continue;
        if (isOffboardedTagName(tag, offboarded)) continue;
        const stage = deriveStage(name);
        if (!REVIVABLE_STAGE.test(stage)) continue;
        const status = String(c.status || "").toLowerCase();
        if (status !== "completed" && !(status === "paused" && pausedByUs[`${instance}:${c.id}`])) continue;
        candidates.push({ instance, id: c.id, name, tag, stage, status, totalLeads: c.total_leads ?? 0, emailsSent: c.emails_sent ?? 0 });
      }
    }
    // Our pauses that are no longer paused were resumed or archived by a
    // person — forget them so we never resume them later.
    const stillOurs = new Set(candidates.filter((c) => c.status === "paused").map((c) => `${c.instance}:${c.id}`));
    const forgotten = Object.keys(pausedByUs).filter((k) => !stillOurs.has(k) && !listFailed.some((i) => k.startsWith(`${i}:`)));
    if (redis && !dryRun && !onlyTag && forgotten.length > 0) await redis.hdel(PAUSED_KEY, ...forgotten);

    interface Result { instance: string; id: number; name: string; tag: string; action: string; detail: string; leadsDue?: number }
    const results: Result[] = [];
    const outOfLeads: Candidate[] = [];
    const wontSend: (Candidate & { due: number; wokenAt: string })[] = [];
    const uncounted = new Set<BisonInstanceSlug>(listFailed);
    let revived = 0;
    let budgetHit = false;

    for (const c of candidates) {
      if (Date.now() - startedAt > BUDGET_MS) { budgetHit = true; break; }
      const key = `${c.instance}:${c.id}`;
      const row = { instance: c.instance, id: c.id, name: c.name, tag: c.tag };

      const gate = goLiveCleared(c.tag, goLive);
      if (!gate.cleared) {
        results.push({ ...row, action: "skip", detail: gate.reason ?? "not cleared to go live" });
        continue;
      }

      const ours = c.status === "paused";
      const due = ours ? null : await dueLeads(c.instance, c.id);
      if (!ours) {
        if (due === null) {
          uncounted.add(c.instance);
          results.push({ ...row, action: "skip", detail: "could not count leads due — rechecked next run" });
          continue;
        }
        if (due === 0) {
          outOfLeads.push(c);
          results.push({ ...row, action: "out-of-leads", detail: `no lead left to send (${c.totalLeads} leads, all finished or stopped)`, leadsDue: 0 });
          continue;
        }
        // Woken within the last day and Bison finished it again without a
        // single email going out — another wake would only repeat that.
        const prev = woken[key];
        if (prev && Date.now() - Date.parse(prev.at) < RETRY_WAKE_MS && c.emailsSent <= prev.emailsSent) {
          wontSend.push({ ...c, due, wokenAt: prev.at });
          results.push({ ...row, action: "wont-send", detail: `${due} leads due, but completed again after the wake at ${prev.at} without sending`, leadsDue: due });
          continue;
        }
      }

      if (revived >= cap) {
        uncounted.add(c.instance);
        results.push({ ...row, action: "skip", detail: "run cap reached — next run", leadsDue: due ?? undefined });
        continue;
      }
      if (dryRun) {
        results.push({ ...row, action: "would-revive", detail: ours ? "resume only (already paused by us)" : "pause → resume", leadsDue: due ?? undefined });
        revived++;
        continue;
      }
      if (!redis) {
        results.push({ ...row, action: "skip", detail: "Redis unavailable — cannot track our own pause, so not pausing", leadsDue: due ?? undefined });
        continue;
      }

      if (!ours) {
        const p = await bisonFetch(c.instance, `/campaigns/${c.id}/pause`, { method: "PATCH" });
        if (!p.ok) {
          const t = await p.text().catch(() => "");
          results.push({ ...row, action: "failed", detail: `pause HTTP ${p.status} ${t.slice(0, 120)}`, leadsDue: due ?? undefined });
          await logEvents([{ instance: c.instance, clientTag: c.tag, eventType: "error", detail: `revive-completed: could not pause "${c.name}" — HTTP ${p.status}`, signals: { kind: "revive_completed", campaignId: c.id, step: "pause" } }]).catch(() => undefined);
          continue;
        }
        // Recorded before the resume, so a run that dies in between still
        // resumes it next hour.
        await redis.hset(PAUSED_KEY, { [key]: new Date().toISOString() });
        await sleep(SETTLE_MS);
      }

      const r = await bisonFetch(c.instance, `/campaigns/${c.id}/resume`, { method: "PATCH" });
      // Wait for the queue to settle before calling it a failure.
      let afterStatus = "";
      if (r.ok) {
        const deadline = Date.now() + RESUME_VERIFY_MS;
        for (;;) {
          afterStatus = await liveStatus(c.instance, c.id);
          if (afterStatus === "active" || !IN_PROGRESS.has(afterStatus)) break;
          if (Date.now() >= deadline) break;
          await sleep(RESUME_POLL_MS);
        }
      }
      // Still mid-flight after the wait is Bison being slow, not a failure of
      // ours — the stuck-campaign cron owns anything that never leaves the
      // queue. Only a real refusal is logged as an error here.
      const landed = r.ok && (afterStatus === "active" || IN_PROGRESS.has(afterStatus));
      if (!landed) {
        const t = r.ok ? "" : await r.text().catch(() => "");
        results.push({ ...row, action: "failed", detail: `resume ${r.ok ? `left it ${afterStatus || "unknown"}` : `HTTP ${r.status} ${t.slice(0, 120)}`} — retried next run`, leadsDue: due ?? undefined });
        await logEvents([{ instance: c.instance, clientTag: c.tag, eventType: "error", detail: `revive-completed: "${c.name}" is paused and did not resume (${r.ok ? afterStatus : `HTTP ${r.status}`}) — will retry`, signals: { kind: "revive_completed", campaignId: c.id, step: "resume" } }]).catch(() => undefined);
        continue;
      }

      revived++;
      await redis.hdel(PAUSED_KEY, key);
      await redis.hset(WOKEN_KEY, { [key]: { at: new Date().toISOString(), due: due ?? 0, emailsSent: c.emailsSent } satisfies Woken });
      results.push({ ...row, action: "revived", detail: afterStatus === "active" ? `completed → active (${due ?? "?"} leads due)` : `resume accepted, Bison still ${afterStatus} — rechecked next run`, leadsDue: due ?? undefined });
      if (afterStatus === "active") await supabase.from("campaigns").update({ status: "active" }).eq("instance", c.instance).eq("id", c.id);
      await logEvents([{
        instance: c.instance, clientTag: c.tag, eventType: "proposed",
        detail: `revive-completed: "${c.name}" was ${ours ? "left paused by an earlier run — resumed" : `completed with ${due} leads due — paused and resumed`}`,
        signals: { kind: "revive_completed", campaignId: c.id, stage: c.stage, leadsDue: due },
      }]).catch(() => undefined);
    }

    // Dashboard: one row per client + instance, refreshed in place.
    const label = (inst: string) => BISON_INSTANCES[inst as BisonInstanceSlug]?.label ?? inst;
    const groups = new Map<string, { tag: string; instance: BisonInstanceSlug; parts: string[] }>();
    const groupFor = (c: Candidate) => {
      const k = `${c.tag}|completed:${c.instance}`;
      if (!groups.has(k)) groups.set(k, { tag: c.tag, instance: c.instance, parts: [] });
      return groups.get(k)!;
    };
    for (const c of outOfLeads) {
      groupFor(c).parts.push(`"${c.name}" (#${c.id}, ${c.stage}) is out of leads: none of its ${c.totalLeads.toLocaleString()} leads is left to send. Add new leads and it is woken within the hour.`);
    }
    for (const c of wontSend) {
      groupFor(c).parts.push(`"${c.name}" (#${c.id}, ${c.stage}) has ${c.due.toLocaleString()} leads due, but Bison completed it again after LeadSync woke it (${c.wokenAt.slice(0, 16).replace("T", " ")} UTC) without sending. Check it in Bison.`);
    }

    let resolved = 0;
    if (!dryRun) {
      for (const g of groups.values()) {
        await recordPipelineAlert({ source: SOURCE, clientTag: g.tag, step: `completed:${g.instance}`, reason: `Completed on ${label(g.instance)}: ${g.parts.join(" ")}`, silent: true });
      }
      // Clear rows that are no longer true — only where this run actually
      // looked at everything (no failed list, count error or cut-off).
      if (!budgetHit && !onlyTag) {
        const { data: open } = await supabase.from("pipeline_alerts").select("id, client_tag, step").eq("source", SOURCE).eq("status", "open");
        for (const a of (open || []) as { id: string; client_tag: string | null; step: string }[]) {
          const inst = a.step.replace(/^completed:/, "") as BisonInstanceSlug;
          if (uncounted.has(inst) || groups.has(`${a.client_tag}|${a.step}`)) continue;
          await resolveAlert(a.id);
          resolved++;
        }
      }

      const failed = results.filter((x) => x.action === "failed").length;
      if (revived > 0 || failed > 0) {
        await logEvents([{
          eventType: "proposed",
          detail: `revive-completed run: ${revived} revived · ${failed} failed · ${outOfLeads.length} out of leads · ${wontSend.length} won't send · ${Math.round((Date.now() - startedAt) / 1000)}s${budgetHit ? " · budget hit" : ""}`,
          signals: { kind: "revive_completed_run", budgetHit, revived },
        }]).catch(() => undefined);
      }
    }

    return NextResponse.json({
      dryRun, budgetHit, listFailed, candidates: candidates.length,
      revived,
      failed: results.filter((x) => x.action === "failed").length,
      outOfLeads: outOfLeads.length,
      wontSend: wontSend.length,
      resolved,
      results: results.filter((x) => x.action !== "skip" || x.detail.startsWith("could not")),
      skippedCount: results.filter((x) => x.action === "skip").length,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "revive-completed failed" }, { status: 500 });
  }
}
