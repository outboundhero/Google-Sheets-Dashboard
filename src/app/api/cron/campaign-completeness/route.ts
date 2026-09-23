import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import { fetchCampaignSenderEmails, mapConcurrent } from "@/lib/attach-campaigns";
import { Redis } from "@upstash/redis";
import { getHandledDomains, logEvents } from "@/lib/replacement/store";
import { hasBurntTag } from "@/lib/replacement/burnt-tag";
import { ALL_INSTANCE_SLUGS, type BisonInstanceSlug } from "@/lib/bison-instances";
import { getOffboardedClientTags, isOffboardedTagName } from "@/lib/offboarded-tags";
import { deriveStage, deriveSetRole } from "@/lib/campaigns/stage";
import { recordPipelineAlert, resolveAlertsForClients } from "@/lib/pipeline-alerts";

export const maxDuration = 300;

// GET /api/cron/campaign-completeness — every healthy tagged sender is in every
// live campaign of its client. Daily at 7:30 AM PT (Spencer's Loom, 2026-09-16:
// "run in the morning when campaigns are no longer processing… add all client
// tagged accounts that are healthy to the correct client tag campaign").
//
// Why a second pass next to orphan-attach: that cron judges a DOMAIN attached
// from a few sampled senders, so a domain with 40 of 49 senders in a campaign
// looks done and the 9 never arrive (JPCO, Nick 2026-09-23: "maybe it just
// didn't capture all of the email accounts for a couple of domains"). This
// pass compares the campaign's full sender list against the client's tagged
// inboxes and attaches exactly the difference. Per-sender, not per-domain.
//
// Campaign status comes from BISON, not the mirror: the campaign crons run
// every 6 hours, so a campaign launched at 9am was invisible here until the
// afternoon and its senders arrived hours late. One search call per client
// gives fresh status and also sees campaigns created since the last sync
// (JPNNJ's three Nurture 2 campaigns, 2026-09-18).
//
// It also reports an incomplete SET: Spencer's Loom (2026-09-16) — "if it
// doesn't find one of the three main or one of the three nurture campaigns,
// it will tell us and it will recheck". A stage holding 1 or 2 of the 3 send
// roles (Google + Custom / Outlook / SEGs) raises a dashboard heads-up; the
// next pass rechecks and clears it by itself. No Slack.
//
// Rules: active + paused campaigns only (never draft/queued/archived/completed
// — going live is a human step, Nick 2026-09-22); no churned clients; no
// burnt / removed / handled domains. Attaching never changes a campaign's
// status. ?dry=1 previews. One audit event per client with a diff; nothing
// posts to Slack. Time-budgeted; the next day's run picks up where it stopped.

const ATTACHABLE = new Set(["active", "paused"]);
const BUDGET_MS = 240_000;
const BATCH = 100;
// Bison lists campaign senders 15 per page, so one 980-sender campaign is ~66
// calls: a client with six campaigns took the whole budget on the first prod
// run. Walk a client's campaigns concurrently and carry a cursor across runs
// so the fleet completes in a few ticks instead of never.
const CAMPAIGN_CONCURRENCY = 6;
const CURSOR_KEY = "cron:campaign-completeness:cursor";
const CURSOR_TTL_S = 24 * 3600;
const SET_ALERT_SOURCE = "campaign-set";
const SET_ALERT_STEP = "incomplete-set";

function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
}

interface LiveCampaign { id: number; name: string; status: string }

/** A client's campaigns straight from Bison (search matches the "TAG:" prefix). */
async function liveCampaignsForTag(instance: BisonInstanceSlug, tag: string): Promise<LiveCampaign[] | null> {
  const out: LiveCampaign[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await bisonFetch(instance, `/campaigns?search=${encodeURIComponent(tag)}&per_page=100&page=${page}`);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { id: number; name: string; status: string }[] };
    const rows = json.data ?? [];
    for (const c of rows) {
      if (String(c.name || "").split(":")[0].trim().toUpperCase() !== tag) continue;
      out.push({ id: c.id, name: c.name, status: String(c.status || "").toLowerCase() });
    }
    if (rows.length < 15) break;
  }
  return out;
}

/** Stages that are missing one of the three send roles. */
function incompleteStages(campaigns: LiveCampaign[]): { stage: string; have: string[]; missing: string[] }[] {
  const ROLES = ["google_custom", "outlook", "segs"] as const;
  const byStage = new Map<string, Set<string>>();
  for (const c of campaigns) {
    const role = deriveSetRole(c.name);
    if (!role) continue;
    const stage = deriveStage(c.name);
    if (!byStage.has(stage)) byStage.set(stage, new Set());
    byStage.get(stage)!.add(role);
  }
  const out: { stage: string; have: string[]; missing: string[] }[] = [];
  for (const [stage, roles] of byStage) {
    const missing = ROLES.filter((r) => !roles.has(r));
    // Zero roles present means the stage does not exist for this client at all
    // — not our business. One or two means a set was left half-built.
    if (missing.length > 0 && missing.length < ROLES.length) {
      out.push({ stage, have: [...roles], missing });
    }
  }
  return out;
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  try {
    const url = new URL(request.url);
    const dryRun = url.searchParams.get("dry") === "1";
    const onlyTag = (url.searchParams.get("tag") || "").trim().toUpperCase() || null;

    const supabase = getSupabaseAdmin();
    const [handled, offboarded] = await Promise.all([getHandledDomains(), getOffboardedClientTags()]);

    // Which (tag, instance) pairs exist at all — taken from the mirror's
    // campaign rows purely as a list of client tags; every pair's real
    // campaign state is read live below.
    const knownTags = new Set<string>();
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase
        .from("campaigns").select("client_tag")
        .order("id", { ascending: true }).range(off, off + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      for (const c of data as { client_tag: string | null }[]) {
        const tag = (c.client_tag || "").trim().toUpperCase();
        if (tag) knownTags.add(tag);
      }
      if (data.length < 1000) break;
    }

    // Healthy tagged inbox ids per (tag, instance), from the mirror.
    interface DomRow { instance: BisonInstanceSlug; domain: string; tags: string[] | null }
    const domainsByKey = new Map<string, string[]>();
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase
        .from("deliverability_domains").select("instance, domain, tags")
        .in("instance", ALL_INSTANCE_SLUGS).order("domain", { ascending: true }).range(off, off + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      for (const d of data as DomRow[]) {
        if (handled.has(`${d.instance}:${d.domain}`) || hasBurntTag(d.tags)) continue;
        for (const t of d.tags || []) {
          const tag = String(t).trim().toUpperCase();
          if (!knownTags.has(tag)) continue;
          if (isOffboardedTagName(tag, offboarded)) continue;
          if (onlyTag && tag !== onlyTag) continue;
          const k = `${tag}:${d.instance}`;
          if (!domainsByKey.has(k)) domainsByKey.set(k, []);
          domainsByKey.get(k)!.push(d.domain);
        }
      }
      if (data.length < 1000) break;
    }

    interface ClientResult { tag: string; instance: string; domains: number; inboxes: number; campaigns: number; missingBefore: number; attached: number; errors: string[]; incompleteSets?: string[] }
    const results: ClientResult[] = [];
    let budgetHit = false;

    // Stable order (by key) with a resume cursor: each tick continues where the
    // last one stopped and wraps to the start once the fleet is covered.
    const redis = getRedis();
    const allKeys = [...domainsByKey.keys()].sort();
    const cursor = !onlyTag && redis ? await redis.get<string>(CURSOR_KEY).catch(() => null) : null;
    const startIdx = cursor ? Math.max(0, allKeys.indexOf(cursor) + 1) : 0;
    const keys = [...allKeys.slice(startIdx), ...allKeys.slice(0, startIdx)];
    let lastDone: string | null = null;
    for (const k of keys) {
      if (Date.now() - startedAt > BUDGET_MS) { budgetHit = true; break; }
      const [tag, instance] = k.split(":") as [string, BisonInstanceSlug];
      const domains = domainsByKey.get(k) ?? [];
      if (domains.length === 0) continue;

      // All inbox ids for the client's domains on this instance.
      const inboxIds = new Set<number>();
      for (let i = 0; i < domains.length; i += 100) {
        const { data } = await supabase
          .from("deliverability_inboxes").select("id").eq("instance", instance).in("domain", domains.slice(i, i + 100)).limit(10000);
        for (const r of (data || []) as { id: number }[]) inboxIds.add(r.id);
      }
      if (inboxIds.size === 0) continue;

      const res: ClientResult = { tag, instance, domains: domains.length, inboxes: inboxIds.size, campaigns: 0, missingBefore: 0, attached: 0, errors: [] };

      const liveAll = await liveCampaignsForTag(instance, tag);
      if (liveAll === null) { res.errors.push("could not read campaigns from Bison"); results.push(res); continue; }
      const camps = liveAll.filter((c) => ATTACHABLE.has(c.status));
      res.campaigns = camps.length;

      // Half-built set (Spencer's ask) — reported whether or not anything is
      // missing sender-wise, and cleared automatically once complete.
      const gaps = incompleteStages(liveAll.filter((c) => !["archived", "completed"].includes(c.status)));
      if (!dryRun) {
        if (gaps.length > 0) {
          await recordPipelineAlert({
            source: SET_ALERT_SOURCE, clientTag: tag, step: SET_ALERT_STEP, silent: true,
            reason: `${tag} on ${instance}: ${gaps.map((g) => `${g.stage} is missing ${g.missing.join(" + ")}`).join("; ")}. Rechecked every pass.`,
            domains: [],
          }).catch(() => undefined);
        } else {
          await resolveAlertsForClients(SET_ALERT_SOURCE, [tag]).catch(() => undefined);
        }
      }
      if (gaps.length > 0) res.incompleteSets = gaps.map((g) => `${g.stage}: missing ${g.missing.join(" + ")}`);
      if (camps.length === 0) { results.push(res); lastDone = k; continue; }
      const lists = await mapConcurrent(camps, CAMPAIGN_CONCURRENCY, async (c) => {
        try { return { c, ids: new Set(await fetchCampaignSenderEmails(instance, c.id)), err: null as string | null }; }
        catch (e) { return { c, ids: null, err: e instanceof Error ? e.message : "failed" }; }
      });
      for (const { c, ids, err } of lists) {
        if (!ids) { res.errors.push(`${c.name}: list ${err}`); continue; }
        const missing = [...inboxIds].filter((id) => !ids.has(id));
        res.missingBefore += missing.length;
        if (missing.length === 0 || dryRun) continue;
        for (let i = 0; i < missing.length; i += BATCH) {
          const batch = missing.slice(i, i + BATCH);
          const r = await bisonFetch(instance, `/campaigns/${c.id}/attach-sender-emails`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sender_email_ids: batch }),
          });
          if (r.ok) res.attached += batch.length;
          else res.errors.push(`${c.name}: attach HTTP ${r.status}`);
        }
      }
      results.push(res);
      lastDone = k;
      if (!dryRun && (res.missingBefore > 0 || res.errors.length > 0)) {
        await logEvents([{
          instance, clientTag: tag, eventType: res.errors.length ? "error" : "attached",
          detail: `campaign-completeness: ${res.missingBefore} missing sender slot(s) across ${res.campaigns} campaign(s) — attached ${res.attached}${res.errors.length ? ` · ${res.errors.length} error(s)` : ""}`,
          signals: { kind: "campaign_completeness", ...res },
        }]).catch(() => undefined);
      }
    }

    if (!dryRun && !onlyTag && redis && lastDone) {
      // Wrapped the whole fleet → clear so the next tick starts fresh.
      const wrapped = !budgetHit;
      await (wrapped ? redis.del(CURSOR_KEY) : redis.set(CURSOR_KEY, lastDone, { ex: CURSOR_TTL_S })).catch(() => undefined);
    }
    if (!dryRun) {
      await logEvents([{
        eventType: "proposed",
        detail: `campaign-completeness run: ${results.length} client(s) checked · ${results.reduce((s, r) => s + r.missingBefore, 0)} missing · ${results.reduce((s, r) => s + r.attached, 0)} attached · ${Math.round((Date.now() - startedAt) / 1000)}s${budgetHit ? " · budget hit, continues tomorrow" : ""}`,
        signals: { kind: "campaign_completeness_run", budgetHit, clients: results.length },
      }]).catch(() => undefined);
    }

    return NextResponse.json({
      dryRun, budgetHit, clientsChecked: results.length, elapsedMs: Date.now() - startedAt,
      totalMissing: results.reduce((s, r) => s + r.missingBefore, 0),
      totalAttached: results.reduce((s, r) => s + r.attached, 0),
      results: results.filter((r) => r.missingBefore > 0 || r.errors.length > 0 || (r.incompleteSets?.length ?? 0) > 0),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "campaign-completeness failed" }, { status: 500 });
  }
}
