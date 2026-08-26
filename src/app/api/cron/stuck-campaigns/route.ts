import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import { recordPipelineAlert, listOpenAlerts, resolveAlert, pipelineAlertChannel } from "@/lib/pipeline-alerts";
import { postSlackMessage } from "@/lib/slack";
import { ALL_INSTANCE_SLUGS, INSTANCE_SHORT_LABELS, type BisonInstanceSlug } from "@/lib/bison-instances";

export const maxDuration = 60;

// GET /api/cron/stuck-campaigns — hourly: any campaign, on any of the 4 Bison
// instances, sitting in launch-processing for more than 24h raises a loud
// alert — dashboard banner + #leadsync-outbound Slack — via the existing
// pipeline-alerts store, and auto-resolves once the campaign moves on.
//
// Spencer 2026-08-26 ("urgent — we need to escalate to the EmailBison team
// and need alarming if a campaign is stuck in processing"). Bison's UI shows
// this state as "Processing" / filter "Launch Processing"; its API reports it
// as status `queued` (verified: the 4 campaigns in his screenshot are stored
// as queued), with `launching` as the transient step before it.
//
// `queued` alone is NOT enough (first digest, 2026-08-26, over-flagged): it
// also covers campaigns merely waiting for leads/schedule, and the synced
// table keeps rows for campaigns since deleted in Bison. Bison's updated_at
// is useless as a since-marker (it moves while stuck). So each candidate is
// checked LIVE, and "stuck" means: still queued/launching in Bison, leads
// left to contact, and emails_sent unchanged for 24h+ from when we first saw
// it in that state (Redis snapshot; sends moving resets the clock). 404 in
// Bison → the stale local row is pruned, never alerted. Reasons are bucketed
// by whole days so Slack re-pings once a day per stuck campaign.
//
// ?dry=1 previews without writing.

const PROCESSING = new Set(["queued", "launching", "launch processing", "launch-processing", "processing"]);
const THRESHOLD_HOURS = 24;
const SOURCE = "stuck-campaign";
const SEEN_KEY = "cron:stuck-campaigns:first-seen";
// Slack is ONE digest per run, not one message per campaign (20 stuck ≠ 20
// pings). It posts when the stuck set changes (new campaign, or one crosses
// another full day) and otherwise at most once every 24h as a reminder.
const DIGEST_KEY = "cron:stuck-campaigns:last-digest";
const REMINDER_HOURS = 24;

interface CampaignRow {
  id: number;
  instance: string;
  name: string;
  status: string;
  client_tag: string | null;
  updated_at: string | null;
  synced_at: string | null;
}

function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const dryRun = params.get("dry") === "1";
    // ?probe=instance:id — raw Bison campaign JSON, read-only. Used to learn
    // which field distinguishes a launch stuck in "Processing" from a queued
    // campaign that is merely waiting for leads/schedule (first digest
    // over-flagged the latter).
    const probe = (params.get("probe") || "").trim();
    if (probe) {
      const [inst, id] = probe.split(":");
      if (!ALL_INSTANCE_SLUGS.includes(inst as BisonInstanceSlug) || !id) {
        return NextResponse.json({ error: "probe=instance:id" }, { status: 400 });
      }
      const res = await bisonFetch(inst as BisonInstanceSlug, `/campaigns/${encodeURIComponent(id)}`);
      const json = await res.json().catch(() => null);
      return NextResponse.json({ probe, httpStatus: res.status, campaign: json });
    }
    const supabase = getSupabaseAdmin();
    const nowMs = Date.now();

    const rows: CampaignRow[] = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase
        .from("campaigns")
        .select("id, instance, name, status, client_tag, updated_at, synced_at")
        .in("instance", ALL_INSTANCE_SLUGS)
        .range(off, off + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      rows.push(...(data as CampaignRow[]));
      if (data.length < 1000) break;
    }

    const processing = rows.filter((r) => PROCESSING.has((r.status || "").trim().toLowerCase()));
    const keyOf = (r: { instance: string; id: number }) => `${r.instance}:${r.id}`;

    // First-seen snapshots (Redis): when we first saw the campaign in this
    // state and how many emails it had sent then. Older entries from the first
    // version were bare ISO strings — honored as a timestamp with no send count.
    interface Seen { at: string; emailsSent: number | null }
    const redis = getRedis();
    let seenRaw: Record<string, Seen | string> = {};
    if (redis) {
      try { seenRaw = (await redis.get<Record<string, Seen | string>>(SEEN_KEY)) ?? {}; } catch { seenRaw = {}; }
    }
    const nextSeen: Record<string, Seen> = {};

    const stuck: { key: string; instance: string; id: number; name: string; clientTag: string | null; hours: number; since: string }[] = [];
    const watching: { key: string; name: string; hours: number; note: string }[] = [];
    const pruned: string[] = [];

    for (const r of processing) {
      const k = keyOf(r);

      // Live check — the synced status can be hours stale, and a campaign
      // deleted in Bison keeps its local row until something prunes it.
      let live: { status: string; emailsSent: number; totalLeads: number; contacted: number } | null = null;
      let liveHttp = 0;
      try {
        const res = await bisonFetch(r.instance as BisonInstanceSlug, `/campaigns/${r.id}`);
        liveHttp = res.status;
        const j = await res.json().catch(() => null);
        const c = j?.data ?? j;
        if (res.ok && c && typeof c.status === "string") {
          live = {
            status: c.status,
            emailsSent: Number(c.emails_sent) || 0,
            totalLeads: Number(c.total_leads) || 0,
            contacted: Number(c.total_leads_contacted) || 0,
          };
        }
      } catch {
        live = null;
      }

      if (liveHttp === 404) {
        // Gone in Bison (JPCL Nurture 2 / JPCNJ Batch 2 on the first run) —
        // prune the stale row so nothing downstream trusts it, never alert.
        if (!dryRun) await supabase.from("campaigns").delete().eq("instance", r.instance).eq("id", r.id);
        pruned.push(`${k} ${r.name}`);
        continue;
      }
      if (!live) { watching.push({ key: k, name: r.name, hours: 0, note: `live check failed (HTTP ${liveHttp})` }); continue; }
      if (!PROCESSING.has(live.status.trim().toLowerCase())) continue;            // moved on since the sync
      if (live.totalLeads > 0 && live.contacted >= live.totalLeads) {
        watching.push({ key: k, name: r.name, hours: 0, note: "queued with nothing left to send — waiting for leads, not stuck" });
        continue;
      }

      const prev = seenRaw[k];
      const prevAt = typeof prev === "string" ? prev : prev?.at;
      const prevSent = typeof prev === "object" && prev ? prev.emailsSent : null;
      const sendsMoved = prevSent != null && live.emailsSent > prevSent;
      const at = prevAt && !sendsMoved ? prevAt : new Date(nowMs).toISOString();
      nextSeen[k] = { at, emailsSent: live.emailsSent };
      const hours = Math.floor((nowMs - new Date(at).getTime()) / 3_600_000);
      if (hours >= THRESHOLD_HOURS) {
        stuck.push({ key: k, instance: r.instance, id: r.id, name: r.name, clientTag: r.client_tag, hours, since: at });
      } else {
        watching.push({ key: k, name: r.name, hours, note: sendsMoved ? "sends moving — clock reset" : `no sends for ${hours}h, under threshold` });
      }
    }
    stuck.sort((a, b) => b.hours - a.hours);

    // Open alerts from this source that are no longer stuck → resolve.
    const open = (await listOpenAlerts()).filter((a) => a.source === SOURCE);
    const stuckKeys = new Set(stuck.map((s) => s.key));
    const toResolve = open.filter((a) => !stuckKeys.has(a.step));

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        processing: processing.length,
        stuck: stuck.map((s) => ({ instance: s.instance, campaign: s.name, clientTag: s.clientTag, hours: s.hours, since: s.since })),
        watching,
        wouldPrune: pruned,
        wouldResolve: toResolve.map((a) => a.step),
      });
    }

    if (redis) {
      try { await redis.set(SEEN_KEY, nextSeen); } catch { /* tracking is best-effort */ }
    }

    // Dashboard: one row per stuck campaign (dismissable individually), silent.
    const labelOf = (inst: string) => INSTANCE_SHORT_LABELS[inst as BisonInstanceSlug] ?? inst;
    for (const s of stuck) {
      const days = Math.floor(s.hours / 24);
      await recordPipelineAlert({
        source: SOURCE,
        clientTag: s.clientTag,
        step: s.key,
        reason: `"${s.name}" has been in Processing on ${labelOf(s.instance)} for ${days}d+ (since ${s.since.slice(0, 16).replace("T", " ")} UTC) — escalate to EmailBison`,
        domains: [],
        silent: true,
      });
    }
    for (const a of toResolve) await resolveAlert(a.id);

    // Slack: ONE digest. Signature = which campaigns are stuck + their day
    // bucket; post on change, or as a daily reminder while anything is stuck.
    let slack: { posted: boolean; reason: string } = { posted: false, reason: "nothing stuck" };
    if (stuck.length > 0) {
      const signature = stuck.map((s) => `${s.key}@${Math.floor(s.hours / 24)}`).sort().join("|");
      let last: { signature: string; postedAt: string } | null = null;
      if (redis) {
        try { last = (await redis.get<{ signature: string; postedAt: string }>(DIGEST_KEY)) ?? null; } catch { last = null; }
      }
      const hoursSinceLast = last ? (nowMs - new Date(last.postedAt).getTime()) / 3_600_000 : Infinity;
      const changed = !last || last.signature !== signature;
      if (changed || hoursSinceLast >= REMINDER_HOURS) {
        const byInstance = new Map<string, typeof stuck>();
        for (const s of stuck) byInstance.set(s.instance, [...(byInstance.get(s.instance) ?? []), s]);
        const lines: string[] = [
          `:rotating_light: *${stuck.length} campaign${stuck.length === 1 ? "" : "s"} stuck in Processing for 24h+* — escalate to EmailBison`,
        ];
        for (const [inst, list] of byInstance) {
          lines.push(`*${labelOf(inst)}*`);
          for (const s of list) {
            const d = Math.floor(s.hours / 24);
            lines.push(`• ${s.name}${s.clientTag ? ` (${s.clientTag})` : ""} — ${d}d ${s.hours % 24}h, since ${s.since.slice(0, 10)}`);
          }
        }
        if (toResolve.length > 0) lines.push(`_${toResolve.length} previously-stuck campaign${toResolve.length === 1 ? "" : "s"} moved on since the last check._`);
        lines.push(changed ? "_Shown on the LeadSync dashboard; auto-clears when a campaign launches._" : "_Daily reminder — still stuck. Auto-clears when a campaign launches._");
        const res = await postSlackMessage(lines.join("\n"), pipelineAlertChannel());
        slack = { posted: res.ok, reason: res.ok ? (changed ? "stuck set changed" : "daily reminder") : `slack failed: ${res.reason}` };
        if (res.ok && redis) {
          try { await redis.set(DIGEST_KEY, { signature, postedAt: new Date(nowMs).toISOString() }); } catch { /* best-effort */ }
        }
      } else {
        slack = { posted: false, reason: "unchanged, reminder not due" };
      }
    }

    return NextResponse.json({
      processing: processing.length,
      stuck: stuck.length,
      alerted: stuck.map((s) => `${s.instance}: ${s.name} (${s.hours}h)`),
      resolved: toResolve.length,
      pruned,
      watching,
      slack,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "stuck-campaigns failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
