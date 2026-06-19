// Replacement-plan preview — OBSERVE-ONLY. For each burnt domain, assembles the
// full proposed action (client tag, instance, redirect, target campaigns, the
// reserve domain it would pull, and the per-instance cap check) WITHOUT executing
// anything. Reads Supabase only. This is the "show exactly what it would do" layer
// that ties detection + config maps + reserve pool together.
import { getSupabaseAdmin } from "@/lib/supabase";
import { ALL_INSTANCE_SLUGS, getInstance, type BisonInstanceSlug } from "@/lib/bison-instances";
import { pstDateString } from "@/lib/date-utils";
import { getSettings } from "./store";
import { evaluateDomain, type DomainSignals } from "./detect";
import { deriveCampaignMap, type CampaignRef } from "./campaigns";
import { INSTANCE_CAP } from "./types";

const WARMUP_DAYS = 21; // a domain is "Complete" once it is >= 21 days old

interface DomRow {
  instance: BisonInstanceSlug;
  domain: string;
  tags: string[] | null;
  total_sent: number | null;
  total_replied: number | null;
  total_bounced: number | null;
  blacklisted: boolean | null;
  spamhaus_dbl: boolean | null;
  domain_created_at: string | null;
  outlook_count: number | null;
  google_count: number | null;
}

export type Provider = "outlook" | "google" | "mixed" | "unknown";

/** A domain's mailbox provider, from its inbox counts. */
function providerOf(d: { outlook_count: number | null; google_count: number | null }): Provider {
  const o = d.outlook_count ?? 0, g = d.google_count ?? 0;
  if (o > 0 && g > 0) return "mixed";
  if (o > 0) return "outlook";
  if (g > 0) return "google";
  return "unknown";
}
interface RateRow { instance: BisonInstanceSlug; domain: string; reply_10: number|null; reply_15: number|null; reply_30: number|null; bounce_10: number|null; bounce_15: number|null; bounce_30: number|null; }

export interface PlanItem {
  burntDomain: string;
  instance: BisonInstanceSlug;
  provider: Provider;                  // burnt domain's mailbox provider
  clientTag: string | null;
  reasons: string[];
  redirectUrl: string | null;
  targetCampaigns: CampaignRef[];
  replacementDomain: string | null;   // reserve domain (SAME provider) that would be pulled
  capCurrent: number;                  // current assigned domains for (tag, instance)
  capMax: number;                      // 5 (b2c) | 20 (b2b)
  blockers: string[];                  // why this can't proceed (missing redirect, no campaign, no reserve, at cap)
}

// reserve ready counts per instance, split by provider
export interface ReserveReady { outlook: number; google: number }

export interface PlanResult {
  generatedFor: string;            // pst date
  burntCount: number;
  items: PlanItem[];
  reserveReadyByInstance: Record<string, ReserveReady>;
}

function ageDays(created: string | null, nowMs: number): number {
  if (!created) return 0;
  return Math.floor((nowMs - new Date(created).getTime()) / 86_400_000);
}

export async function buildReplacementPlan(): Promise<PlanResult> {
  const supabase = getSupabaseAdmin();
  const cfg = await getSettings();
  const today = pstDateString(new Date());
  const nowMs = new Date(today).getTime();

  // 1) all domains (with tags + fields)
  const domains: DomRow[] = [];
  let off = 0;
  while (true) {
    const { data, error } = await supabase
      .from("deliverability_domains")
      .select("instance,domain,tags,total_sent,total_replied,total_bounced,blacklisted,spamhaus_dbl,domain_created_at,outlook_count,google_count")
      .in("instance", ALL_INSTANCE_SLUGS)
      .range(off, off + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    domains.push(...(data as DomRow[]));
    if (data.length < 1000) break;
    off += 1000;
  }

  // 2) windowed rates if needed
  const rateByKey = new Map<string, RateRow>();
  if (cfg.lookbackWindow !== "all") {
    let r = 0;
    while (true) {
      const { data, error } = await supabase
        .rpc("trailing_domain_rates", { p_instances: ALL_INSTANCE_SLUGS, p_today: today })
        .range(r, r + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      for (const row of data as RateRow[]) rateByKey.set(`${row.instance}:${row.domain}`, row);
      if (data.length < 1000) break;
      r += 1000;
    }
  }

  // 3) config maps
  const { data: redirectRows } = await supabase.from("client_redirects").select("client_tag,redirect_url");
  const redirectByTag = new Map<string, string>();
  for (const row of (redirectRows || []) as { client_tag: string; redirect_url: string }[]) {
    redirectByTag.set(row.client_tag.toUpperCase(), row.redirect_url);
  }
  const campaignMap = await deriveCampaignMap();
  const campaignsByKey = new Map<string, CampaignRef[]>();
  const knownTags = new Set<string>(redirectByTag.keys());
  for (const m of campaignMap.matches) {
    knownTags.add(m.clientTag);
    if (m.eligible.length > 0) campaignsByKey.set(`${m.clientTag}:${m.instance}`, m.eligible);
  }

  // helper: the client tag on a domain (first of its tags that's a known client tag)
  const clientTagOf = (tags: string[] | null): string | null => {
    if (!tags) return null;
    for (const t of tags) { const u = String(t).trim().toUpperCase(); if (knownTags.has(u)) return u; }
    return null;
  };
  const rateOf = (d: DomRow, kind: "reply" | "bounce"): number | null => {
    if (cfg.lookbackWindow === "all") {
      const s = d.total_sent ?? 0; if (s <= 0) return null;
      const n = kind === "reply" ? (d.total_replied ?? 0) : (d.total_bounced ?? 0);
      return Math.round((n / s) * 1000) / 10;
    }
    const r = rateByKey.get(`${d.instance}:${d.domain}`); if (!r) return null;
    const w = cfg.lookbackWindow;
    return kind === "reply"
      ? (w === "10" ? r.reply_10 : w === "15" ? r.reply_15 : r.reply_30)
      : (w === "10" ? r.bounce_10 : w === "15" ? r.bounce_15 : r.bounce_30);
  };

  // 4) build reserve-ready pools per (instance, provider) — consumable. Ready =
  //    no client tag + Complete (>=21d) + not SURBL + not Spamhaus + a pure
  //    provider (outlook or google). Replacement is like-for-like by provider.
  const reservePool = new Map<string, string[]>(); // key: `${instance}:${provider}`
  for (const d of domains) {
    if (clientTagOf(d.tags) !== null) continue;             // reserve = no client tag
    const prov = providerOf(d);
    if (prov !== "outlook" && prov !== "google") continue;  // pure provider only
    if (ageDays(d.domain_created_at, nowMs) < WARMUP_DAYS) continue; // Complete
    if (d.blacklisted === true) continue;                  // SURBL clean
    if (d.spamhaus_dbl === true) continue;                 // Spamhaus clean
    const key = `${d.instance}:${prov}`;
    if (!reservePool.has(key)) reservePool.set(key, []);
    reservePool.get(key)!.push(d.domain);
  }
  const reserveReadyByInstance: Record<string, ReserveReady> = {};
  for (const inst of ALL_INSTANCE_SLUGS) {
    reserveReadyByInstance[inst] = {
      outlook: reservePool.get(`${inst}:outlook`)?.length ?? 0,
      google: reservePool.get(`${inst}:google`)?.length ?? 0,
    };
  }

  // current assigned-domain count per (tag, instance) — for the cap check
  const assignedCount = new Map<string, number>();
  for (const d of domains) {
    const tag = clientTagOf(d.tags);
    if (!tag) continue;
    const k = `${tag}:${d.instance}`;
    assignedCount.set(k, (assignedCount.get(k) || 0) + 1);
  }

  // 5) burnt domains -> plan items
  const items: PlanItem[] = [];
  for (const d of domains) {
    const signals: DomainSignals = {
      instance: d.instance, domain: d.domain, totalSent: d.total_sent ?? 0,
      replyRate: rateOf(d, "reply"), bounceRate: rateOf(d, "bounce"),
      surbl: d.blacklisted, spamhaus: d.spamhaus_dbl,
    };
    const res = evaluateDomain(signals, cfg);
    if (!res.burnt) continue;

    const tag = clientTagOf(d.tags);
    const provider = providerOf(d);
    const redirectUrl = tag ? redirectByTag.get(tag) ?? null : null;
    const targetCampaigns = tag ? campaignsByKey.get(`${tag}:${d.instance}`) ?? [] : [];
    const capMax = INSTANCE_CAP[getInstance(d.instance).tier];
    const capCurrent = tag ? assignedCount.get(`${tag}:${d.instance}`) ?? 0 : 0;

    // pull a like-for-like reserve domain (same instance + same provider), consumed
    const pool = (provider === "outlook" || provider === "google")
      ? reservePool.get(`${d.instance}:${provider}`) : undefined;
    const replacementDomain = pool && pool.length > 0 ? pool.shift()! : null;

    const blockers: string[] = [];
    if (!tag) blockers.push("no client tag on domain");
    if (tag && !redirectUrl) blockers.push("no redirect URL for tag");
    if (tag && targetCampaigns.length === 0) blockers.push("no eligible campaign in this instance");
    if (provider === "mixed" || provider === "unknown") blockers.push(`${provider}-provider domain (manual)`);
    else if (!replacementDomain) blockers.push(`no ready ${provider} reserve in this instance`);

    items.push({
      burntDomain: d.domain, instance: d.instance, provider, clientTag: tag, reasons: res.reasons,
      redirectUrl, targetCampaigns, replacementDomain, capCurrent, capMax, blockers,
    });
  }

  items.sort((a, b) => (a.clientTag || "~").localeCompare(b.clientTag || "~") || a.instance.localeCompare(b.instance));
  return { generatedFor: today, burntCount: items.length, items, reserveReadyByInstance };
}
