// Replacement-plan preview — OBSERVE-ONLY. For each burnt domain, assembles the
// full proposed action (client tag, instance, redirect, target campaigns, the
// reserve domain it would pull, and the per-instance cap check) WITHOUT executing
// anything. Reads Supabase only. This is the "show exactly what it would do" layer
// that ties detection + config maps + reserve pool together.
import { getSupabaseAdmin } from "@/lib/supabase";
import { ALL_INSTANCE_SLUGS, getInstance, type BisonInstanceSlug } from "@/lib/bison-instances";
import { pstDateString } from "@/lib/date-utils";
import { getSettings, getHandledDomains } from "./store";
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
  surbl: boolean | null;               // SURBL listed (null = unchecked)
  spamhaus: boolean | null;            // Spamhaus DBL listed (null = unchecked)
  redirectUrl: string | null;
  targetCampaigns: CampaignRef[];
  replacementDomain: string | null;   // reserve domain (SAME provider) that would be pulled
  removeOnly: boolean;                 // true = burnt removed but NO replacement (client already at cap)
  capCurrent: number;                  // healthy domains that STAY for (tag, instance) — post-removal
  capMax: number;                      // 5 (b2c) | 20 (b2b)
  blockers: string[];                  // why a replacement can't proceed (missing redirect, no campaign, no reserve)
}

// reserve ready counts per instance, split by provider
export interface ReserveReady { outlook: number; google: number }

// per (client_tag, instance) raw domain-count audit — to validate totals/caps
export interface ClientAuditRow {
  clientTag: string;
  instance: string;
  total: number;
  info: number;     // .info domains
  comco: number;    // .com / .co domains
  other: number;    // any other TLD
  outlook: number;
  google: number;
  burnt: number;    // currently flagged burnt
  staying: number;  // domains that STAY (not removed) — the true cap baseline
  capMax: number;
}

export interface PlanResult {
  generatedFor: string;            // pst date
  infoMigration: boolean;          // was migration mode on for this build
  burntCount: number;              // replaceable domains WITH a client tag
  unassignedBurntCount: number;    // replaceable spare/reserve domains (no tag) — clean up, not replace
  items: PlanItem[];
  reserveReadyByInstance: Record<string, ReserveReady>;
  clientAudit: ClientAuditRow[];
}

function ageDays(created: string | null, nowMs: number): number {
  if (!created) return 0;
  return Math.floor((nowMs - new Date(created).getTime()) / 86_400_000);
}

export async function buildReplacementPlan(opts: { infoMigration?: boolean } = {}): Promise<PlanResult> {
  const infoMigration = opts.infoMigration ?? false;
  const supabase = getSupabaseAdmin();
  const cfg = await getSettings();
  const today = pstDateString(new Date());
  const nowMs = new Date(today).getTime();

  // domains already removed/in-flight from a prior execution — exclude so they
  // disappear from the plan the moment they're executed.
  const handled = await getHandledDomains();

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
    for (const d of data as DomRow[]) if (!handled.has(`${d.instance}:${d.domain}`)) domains.push(d);
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

  // 4) enrich every domain once: provider, client tag, TLD, burnt verdict, and
  //    whether it's "replaceable". In .info-migration mode EVERY .info counts as
  //    replaceable (not just flagged ones) so a mass migration isn't blocked by
  //    not-yet-flagged .info domains.
  const isInfo = (dom: string) => dom.toLowerCase().endsWith(".info");
  const tldCat = (dom: string): "info" | "comco" | "other" => {
    const l = dom.toLowerCase();
    if (l.endsWith(".info")) return "info";
    if (l.endsWith(".com") || l.endsWith(".co")) return "comco";
    return "other";
  };
  interface Enriched { d: DomRow; provider: Provider; tag: string | null; burnt: boolean; replaceable: boolean; reasons: string[] }
  const enriched: Enriched[] = domains.map((d) => {
    const signals: DomainSignals = {
      instance: d.instance, domain: d.domain, totalSent: d.total_sent ?? 0,
      replyRate: rateOf(d, "reply"), bounceRate: rateOf(d, "bounce"),
      surbl: d.blacklisted, spamhaus: d.spamhaus_dbl,
    };
    const r = evaluateDomain(signals, cfg);
    const replaceable = r.burnt || (infoMigration && isInfo(d.domain));
    const reasons = r.burnt ? r.reasons : (replaceable ? [".info domain (migration)"] : []);
    return { d, provider: providerOf(d), tag: clientTagOf(d.tags), burnt: r.burnt, replaceable, reasons };
  });

  // 5) reserve-ready pools per (instance, provider) — consumable. Ready =
  //    unassigned (no client tag) + pure provider + Complete (>=21d) + SURBL &
  //    Spamhaus clean + NOT itself burnt + NOT a .info (we are migrating OFF
  //    .info, so never pull one as a replacement).
  const reservePool = new Map<string, string[]>(); // key: `${instance}:${provider}`
  for (const e of enriched) {
    if (e.tag !== null) continue;
    if (e.provider !== "outlook" && e.provider !== "google") continue;
    if (isInfo(e.d.domain)) continue;
    if (ageDays(e.d.domain_created_at, nowMs) < WARMUP_DAYS) continue;
    if (e.d.blacklisted === true || e.d.spamhaus_dbl === true) continue;
    if (e.burnt) continue;
    const key = `${e.d.instance}:${e.provider}`;
    if (!reservePool.has(key)) reservePool.set(key, []);
    reservePool.get(key)!.push(e.d.domain);
  }
  const reserveReadyByInstance: Record<string, ReserveReady> = {};
  for (const inst of ALL_INSTANCE_SLUGS) {
    reserveReadyByInstance[inst] = {
      outlook: reservePool.get(`${inst}:outlook`)?.length ?? 0,
      google: reservePool.get(`${inst}:google`)?.length ?? 0,
    };
  }

  // 6) cap baseline = assigned domains that STAY (not replaceable). Normal mode:
  //    non-burnt. Migration mode: also excludes .info, leaving only the good
  //    .com/.co domains — so there's room to swap .info out for fresh ones.
  const stayingAssigned = new Map<string, number>();
  for (const e of enriched) {
    if (!e.tag || e.replaceable) continue;
    const k = `${e.tag}:${e.d.instance}`;
    stayingAssigned.set(k, (stayingAssigned.get(k) || 0) + 1);
  }

  // 6b) per-(tag,instance) raw domain-count audit (validates totals/caps)
  interface AuditAcc { total: number; info: number; comco: number; other: number; outlook: number; google: number; burnt: number }
  const auditMap = new Map<string, AuditAcc>();
  for (const e of enriched) {
    if (!e.tag) continue;
    const k = `${e.tag}:${e.d.instance}`;
    let a = auditMap.get(k);
    if (!a) { a = { total: 0, info: 0, comco: 0, other: 0, outlook: 0, google: 0, burnt: 0 }; auditMap.set(k, a); }
    a.total++;
    a[tldCat(e.d.domain)]++;
    if (e.provider === "outlook") a.outlook++; else if (e.provider === "google") a.google++;
    if (e.burnt) a.burnt++;
  }
  const clientAudit: ClientAuditRow[] = [...auditMap.entries()].map(([k, a]) => {
    const sep = k.lastIndexOf(":");
    const clientTag = k.slice(0, sep), instance = k.slice(sep + 1) as BisonInstanceSlug;
    return {
      clientTag, instance, ...a,
      staying: stayingAssigned.get(k) ?? 0,   // matches the plan's healthy count (mode-aware)
      capMax: INSTANCE_CAP[getInstance(instance).tier],
    };
  }).sort((x, y) => y.total - x.total);

  // 7) plan items — TOP-UP-TO-CAP model (Spencer 2026-06-24):
  //   * Every burnt domain WITH a tag is REMOVED.
  //   * Replacements added per (tag,instance) = max(0, cap - healthy remaining),
  //     NOT one-per-burnt. So the first `need` burnt domains in a group get a
  //     like-for-like reserve; any beyond that are remove-only (client already
  //     at/over cap — we never remove excess healthy or over-fill).
  //   * Burnt domains with no tag = spare/cleanup, counted separately.
  const replaceableTagged = enriched.filter((e) => e.replaceable && e.tag);
  const unassignedBurntCount = enriched.filter((e) => e.replaceable && !e.tag).length;
  // process each (tag,instance) group contiguously & deterministically
  replaceableTagged.sort((a, b) => a.tag!.localeCompare(b.tag!) || a.d.instance.localeCompare(b.d.instance));

  const assignedInGroup = new Map<string, number>(); // tag:instance -> reserves assigned so far
  const items: PlanItem[] = [];
  for (const e of replaceableTagged) {
    const d = e.d, tag = e.tag!, provider = e.provider;
    const groupKey = `${tag}:${d.instance}`;
    const capMax = INSTANCE_CAP[getInstance(d.instance).tier];
    const healthy = stayingAssigned.get(groupKey) ?? 0;        // domains that STAY
    const need = Math.max(0, capMax - healthy);                // top-up target, never beyond cap
    const already = assignedInGroup.get(groupKey) ?? 0;

    const redirectUrl = redirectByTag.get(tag) ?? null;
    const targetCampaigns = campaignsByKey.get(groupKey) ?? [];

    let replacementDomain: string | null = null;
    let removeOnly = false;
    const blockers: string[] = [];

    if (already < need) {
      // top-up slot: pull a like-for-like reserve (same instance + provider)
      const pool = (provider === "outlook" || provider === "google")
        ? reservePool.get(`${d.instance}:${provider}`) : undefined;
      replacementDomain = pool && pool.length > 0 ? pool.shift()! : null;
      if (replacementDomain) assignedInGroup.set(groupKey, already + 1);
      // blockers only matter when we actually intend to add a replacement
      if (!redirectUrl) blockers.push("no redirect URL for tag");
      if (targetCampaigns.length === 0) blockers.push("no eligible campaign in this instance");
      if (provider === "mixed" || provider === "unknown") blockers.push(`${provider}-provider domain (manual)`);
      else if (!replacementDomain) blockers.push(`no ready ${provider} reserve in this instance`);
    } else {
      // client already at/over cap → remove the burnt domain, add NO replacement.
      // (Never remove excess healthy; just don't over-fill.)
      removeOnly = true;
    }

    items.push({
      burntDomain: d.domain, instance: d.instance, provider, clientTag: tag, reasons: e.reasons,
      surbl: d.blacklisted, spamhaus: d.spamhaus_dbl,
      redirectUrl, targetCampaigns, replacementDomain, removeOnly, capCurrent: healthy, capMax, blockers,
    });
  }
  return { generatedFor: today, infoMigration, burntCount: items.length, items, reserveReadyByInstance, unassignedBurntCount, clientAudit };
}
