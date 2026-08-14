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
import { evaluateSegments, type ThresholdConfig, type DomainMetrics } from "./threshold-groups";
import { deriveCampaignMap, type CampaignRef } from "./campaigns";
import { capFor, getClientTiers } from "./client-tiers";
import { getSkipSet, skipKey } from "./skips";
import { recordFirstFlagged } from "./first-flagged";

// Cross-instance donor (Nick Aug-10): B2C instances with no local reserve pull
// Inboxing-movable reserves from B2B #2. "For now" — single fixed donor.
const CROSS_DONOR = "facilityreach" as const;

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
  /**
   * Where the reserve lives. Normally === `instance`. "facilityreach" when the
   * local pool was empty and an Inboxing-movable B2B#2 reserve is donated
   * (Nick Aug-10: B2C pulls from B2B2 — move over, tag, redirect, map campaigns).
   * Execution must MOVE the domain first when this differs from `instance`.
   */
  replacementFrom: BisonInstanceSlug | null;
  removeOnly: boolean;                 // true = burnt removed but NO replacement (client already at cap)
  capCurrent: number;                  // healthy domains that STAY for (tag, instance) — post-removal
  capMax: number;                      // 5 (b2c) | 20 (b2b)
  blockers: string[];                  // why a replacement can't proceed (missing redirect, no campaign, no reserve)
}

// Reserve counts per instance. `outlook`/`google` are the pool that's actually
// pull-able as a replacement — pure provider, non-.info, non-blacklisted, and
// ≥ 21 days old — matching the strict filters replacement pulls need.
// `total` is Spencer's broader definition: every untagged domain that's ≥ 21
// days old, regardless of TLD or provider. Reported for visibility so a
// domain that's technically warmed but excluded from a pull (mixed provider,
// .info, blacklisted) still shows up as reserve inventory. Nothing on the
// pull path reads `total`.
export interface ReserveReady { outlook: number; google: number; total: number }

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

// One row of reserve inventory — an untagged domain that has finished warmup
// (≥ 21 days). `pullable` tells the UI whether replacement can actually use
// this one as a like-for-like replacement (pure Outlook or Google, non-blacklisted,
// not itself burnt, and — unless allowInfoReserves is on — non-.info) or whether
// it's inventory-only for now.
export interface ReserveDomain {
  instance: BisonInstanceSlug;
  domain: string;
  provider: Provider;
  isInfo: boolean;
  blacklisted: boolean;
  ageDays: number;
  pullable: boolean;
}

export interface PlanResult {
  generatedFor: string;            // pst date
  burntSource?: "guardrails" | "groups"; // which detector decided "burnt" for this build
  infoMigration: boolean;          // was migration mode on for this build
  burntCount: number;              // replaceable domains WITH a client tag
  unassignedBurntCount: number;    // replaceable spare/reserve domains (no tag) — clean up, not replace
  items: PlanItem[];
  reserveReadyByInstance: Record<string, ReserveReady>;
  reserveList: ReserveDomain[];    // every untagged + ≥21d domain (sorted by instance, domain)
  clientAudit: ClientAuditRow[];
  // Skip/Unflag (Spencer's false-positive guard): domains that WOULD be flagged
  // burnt this build but are skipped — excluded from replace/remove/counts,
  // still in campaigns, surfaced so the UI can mark them clearly.
  skippedBurnt?: { instance: BisonInstanceSlug; domain: string; clientTag: string | null; reasons: string[] }[];
  skippedCount?: number;           // total skip rows loaded (flagged or not)
}

function ageDays(created: string | null, nowMs: number): number {
  if (!created) return 0;
  return Math.floor((nowMs - new Date(created).getTime()) / 86_400_000);
}

export async function buildReplacementPlan(
  opts: { infoMigration?: boolean; burntSource?: "guardrails" | "groups"; groupConfig?: ThresholdConfig } = {},
): Promise<PlanResult> {
  const infoMigration = opts.infoMigration ?? false;
  // Detection source. Default = the flat guardrails (unchanged behaviour for
  // every existing caller). "groups" swaps ONLY the burnt verdict to Spencer's
  // segmented per-client-tag threshold groups — the rest of the plan (reserve,
  // caps, top-up, campaigns) is identical. Still observe-only: executes nothing.
  const burntSource = opts.burntSource ?? "guardrails";
  const groupConfig = opts.groupConfig;
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

  // 2) windowed rates if needed. Always load them when detecting via groups —
  //    the group rules are window-based (reply15d/30d, bounce30d↩15d) regardless
  //    of the flat guardrails' lookback setting.
  const rateByKey = new Map<string, RateRow>();
  if (cfg.lookbackWindow !== "all" || burntSource === "groups") {
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
  // Caps are per CLIENT TIER, not per instance (Nick 2026-08-13: Tier 0.5/1 =
  // 20 b2b + 5 b2c, Tier 2 = 40 b2b + 10 b2c). This used to read a flat
  // INSTANCE_CAP of 20/5, which silently held Tier 2 clients to half their
  // allowance. An unknown tag falls back to tier 1 inside `capFor`'s caller
  // contract — the conservative low cap, so a missing tier never over-fills.
  const clientTiers = await getClientTiers();
  const capForTag = (tag: string | null, instance: BisonInstanceSlug) =>
    capFor(getInstance(instance).tier, (tag && clientTiers.get(tag)) || "1");
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
  // "is this domain burnt?" — either the flat guardrails (default) or the
  // segmented threshold groups. Only this verdict differs between the two paths.
  const burntVerdict = (d: DomRow): { burnt: boolean; reasons: string[] } => {
    if (burntSource === "groups" && groupConfig) {
      const rr = rateByKey.get(`${d.instance}:${d.domain}`);
      const m: DomainMetrics = {
        sent: d.total_sent ?? 0,
        reply_10: rr?.reply_10 ?? null, reply_15: rr?.reply_15 ?? null, reply_30: rr?.reply_30 ?? null,
        bounce_10: rr?.bounce_10 ?? null, bounce_15: rr?.bounce_15 ?? null, bounce_30: rr?.bounce_30 ?? null,
        surbl: d.blacklisted, spamhaus: d.spamhaus_dbl,
      };
      const tagsUpper = new Set((d.tags || []).map((t) => String(t).trim().toUpperCase()));
      const v = evaluateSegments(m, tagsUpper, groupConfig);
      // prefix reasons with which segment › group fired (Spencer: "save which group triggered")
      return { burnt: v.burnt, reasons: v.burnt ? [`${v.segmentName} › ${v.groupName}`, ...v.reasons] : [] };
    }
    const signals: DomainSignals = {
      instance: d.instance, domain: d.domain, totalSent: d.total_sent ?? 0,
      replyRate: rateOf(d, "reply"), bounceRate: rateOf(d, "bounce"),
      surbl: d.blacklisted, spamhaus: d.spamhaus_dbl,
    };
    const r = evaluateDomain(signals, cfg);
    return { burnt: r.burnt, reasons: r.burnt ? r.reasons : [] };
  };
  // Skip/Unflag layer: a skipped domain is NEVER treated as burnt/replaceable
  // (not replaced, not removed, not counted) — it stays put and keeps showing
  // health. Would-be-burnt skips are reported separately so the UI marks them.
  const skipSet = await getSkipSet();
  const skippedBurnt: NonNullable<PlanResult["skippedBurnt"]>[number][] = [];
  const flaggedNow: { instance: string; domain: string }[] = [];
  const enriched: Enriched[] = domains.map((d) => {
    const v = burntVerdict(d);
    if (v.burnt) flaggedNow.push({ instance: d.instance, domain: d.domain });
    const skipped = skipSet.has(skipKey(d.instance, d.domain));
    if (skipped && v.burnt) {
      skippedBurnt.push({ instance: d.instance, domain: d.domain, clientTag: clientTagOf(d.tags), reasons: v.reasons });
    }
    const burnt = v.burnt && !skipped;
    const replaceable = burnt || (!skipped && infoMigration && isInfo(d.domain));
    const reasons = burnt ? v.reasons : (replaceable ? [".info domain (migration)"] : []);
    return { d, provider: providerOf(d), tag: clientTagOf(d.tags), burnt, replaceable, reasons };
  });
  // remember WHEN each domain first entered the flagged system (insert-only,
  // fail-open) — plan builds run from several daily crons, so the dates stay
  // fresh even when no one opens the page
  await recordFirstFlagged(flaggedNow);

  // 5) reserve-ready pools per (instance, provider) — consumable. Ready =
  //    unassigned (no client tag) + pure provider + Complete (>=21d) + SURBL &
  //    Spamhaus clean + NOT itself burnt.
  //    `.info` is allowed while cfg.allowInfoReserves is on (Spencer, Aug-13:
  //    "let's start reusing .info domains going forward"). In .info-MIGRATION
  //    mode we still refuse them regardless of the setting — that mode exists to
  //    replace .info domains, so handing one back as the replacement is a no-op.
  const allowInfo = cfg.allowInfoReserves && !infoMigration;
  const reservePool = new Map<string, string[]>(); // key: `${instance}:${provider}`
  for (const e of enriched) {
    if (e.tag !== null) continue;
    if (e.provider !== "outlook" && e.provider !== "google") continue;
    if (!allowInfo && isInfo(e.d.domain)) continue;
    if (ageDays(e.d.domain_created_at, nowMs) < WARMUP_DAYS) continue;
    // SURBL-listed reserves: allowed while cfg.allowSurblReserves is on (Nick +
    // Spencer, Aug-10: "allow SURBL blacklist for now" — it's what's available;
    // flip the setting off once inventory recovers). Clean ones are consumed
    // first (pool sorted below). Spamhaus DBL stays a hard block either way.
    if (e.d.spamhaus_dbl === true) continue;
    if (!cfg.allowSurblReserves && e.d.blacklisted === true) continue;
    if (e.burnt) continue;
    // A skipped domain hid its burnt verdict above — never pull it as a reserve.
    if (skipSet.has(skipKey(e.d.instance, e.d.domain))) continue;
    const key = `${e.d.instance}:${e.provider}`;
    if (!reservePool.has(key)) reservePool.set(key, []);
    reservePool.get(key)!.push(e.d.domain);
  }
  // Prefer CLEAN reserves: each pool consumes non-SURBL domains before
  // SURBL-listed ones (listed are allowed, just later in line).
  const surblListed = new Set(
    enriched.filter((e) => e.d.blacklisted === true).map((e) => `${e.d.instance}:${e.d.domain}`),
  );
  // Inboxing-movable reserves — eligible as cross-instance donors (only the
  // Inboxing provider can move a domain's inboxes between Bison instances).
  const inboxingMovable = new Set(
    enriched
      .filter((e) => (e.d.tags || []).some((t) => String(t).trim().toLowerCase().startsWith("inboxing")))
      .map((e) => `${e.d.instance}:${e.d.domain}`),
  );
  // Consumption order (Nick Aug-13): spend the reserves that CANNOT move between
  // instances first — ScaledMail and MilkBox have no move API, so they are only
  // ever usable in the instance they already sit in. Inboxing sorts last so that
  // stock stays free for the cross-instance donor pull below. Keying off the same
  // `inboxingMovable` set the donor picker uses means what we conserve here is
  // exactly what the mover can spend. SURBL-clean still wins inside each group,
  // and `.info` sorts last of all — reusable now, but only once the better
  // stock in that pool is gone.
  for (const [key, list] of reservePool) {
    const inst = key.split(":")[0];
    list.sort((a, b) =>
      Number(inboxingMovable.has(`${inst}:${a}`)) - Number(inboxingMovable.has(`${inst}:${b}`))
      || Number(surblListed.has(`${inst}:${a}`)) - Number(surblListed.has(`${inst}:${b}`))
      || Number(isInfo(a)) - Number(isInfo(b))
      || a.localeCompare(b));
  }

  // Broader "total reserve" per instance — untagged + ≥ 21 days old, nothing
  // else. Doesn't affect what replacement pulls; only shown alongside the
  // per-provider counts so it's obvious how many warmed-up untagged domains
  // exist in total, even the ones filtered out of the pull pool (.info,
  // mixed provider, blacklisted).
  const totalReserveByInstance: Record<string, number> = {};
  for (const inst of ALL_INSTANCE_SLUGS) totalReserveByInstance[inst] = 0;
  const reserveList: ReserveDomain[] = [];
  const pullableKeys = new Set<string>();
  for (const [key, list] of reservePool) for (const d of list) pullableKeys.add(`${key.split(":")[0]}:${d}`);

  for (const e of enriched) {
    if (e.tag !== null) continue;                                    // must be untagged
    const age = ageDays(e.d.domain_created_at, nowMs);
    if (age < WARMUP_DAYS) continue;                                 // must be ≥ 21d
    totalReserveByInstance[e.d.instance] = (totalReserveByInstance[e.d.instance] || 0) + 1;
    reserveList.push({
      instance: e.d.instance,
      domain: e.d.domain,
      provider: e.provider,
      isInfo: isInfo(e.d.domain),
      blacklisted: e.d.blacklisted === true || e.d.spamhaus_dbl === true,
      ageDays: age,
      pullable: pullableKeys.has(`${e.d.instance}:${e.d.domain}`),
    });
  }
  reserveList.sort((a, b) => a.instance.localeCompare(b.instance) || a.domain.localeCompare(b.domain));

  const reserveReadyByInstance: Record<string, ReserveReady> = {};
  for (const inst of ALL_INSTANCE_SLUGS) {
    reserveReadyByInstance[inst] = {
      outlook: reservePool.get(`${inst}:outlook`)?.length ?? 0,
      google: reservePool.get(`${inst}:google`)?.length ?? 0,
      total: totalReserveByInstance[inst] ?? 0,
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
      capMax: capForTag(clientTag, instance),
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
    const capMax = capForTag(tag, d.instance);
    const healthy = stayingAssigned.get(groupKey) ?? 0;        // domains that STAY
    const need = Math.max(0, capMax - healthy);                // top-up target, never beyond cap
    const already = assignedInGroup.get(groupKey) ?? 0;

    const redirectUrl = redirectByTag.get(tag) ?? null;
    const targetCampaigns = campaignsByKey.get(groupKey) ?? [];

    let replacementDomain: string | null = null;
    let replacementFrom: BisonInstanceSlug | null = null;
    let removeOnly = false;
    const blockers: string[] = [];

    if (already < need) {
      // top-up slot: pull a like-for-like reserve (same instance + provider)
      const pool = (provider === "outlook" || provider === "google")
        ? reservePool.get(`${d.instance}:${provider}`) : undefined;
      replacementDomain = pool && pool.length > 0 ? pool.shift()! : null;
      if (replacementDomain) replacementFrom = d.instance;
      // Cross-instance donor pull (Nick Aug-10): a B2C instance with an empty
      // local pool borrows an INBOXING-movable reserve from B2B#2
      // (facilityreach) — execution moves it over, then tags/redirects/attaches.
      if (!replacementDomain && (provider === "outlook" || provider === "google")
          && getInstance(d.instance).tier === "b2c" && d.instance !== CROSS_DONOR) {
        const donor = reservePool.get(`${CROSS_DONOR}:${provider}`);
        if (donor) {
          const idx = donor.findIndex((dom) => inboxingMovable.has(`${CROSS_DONOR}:${dom}`));
          if (idx >= 0) {
            replacementDomain = donor.splice(idx, 1)[0];
            replacementFrom = CROSS_DONOR;
          }
        }
      }
      if (replacementDomain) assignedInGroup.set(groupKey, already + 1);
      // blockers only matter when we actually intend to add a replacement
      if (!redirectUrl) blockers.push("no redirect URL for tag");
      if (targetCampaigns.length === 0) blockers.push("no eligible campaign in this instance");
      if (provider === "mixed" || provider === "unknown") blockers.push(`${provider}-provider domain (manual)`);
      else if (!replacementDomain) blockers.push(`no ready ${provider} reserve in this instance${getInstance(d.instance).tier === "b2c" ? " (and no Inboxing-movable B2B#2 donor)" : ""}`);
    } else {
      // client already at/over cap → remove the burnt domain, add NO replacement.
      // (Never remove excess healthy; just don't over-fill.)
      removeOnly = true;
    }

    items.push({
      burntDomain: d.domain, instance: d.instance, provider, clientTag: tag, reasons: e.reasons,
      surbl: d.blacklisted, spamhaus: d.spamhaus_dbl,
      redirectUrl, targetCampaigns, replacementDomain, replacementFrom, removeOnly, capCurrent: healthy, capMax, blockers,
    });
  }
  return { generatedFor: today, burntSource, infoMigration, burntCount: items.length, items, reserveReadyByInstance, reserveList, unassignedBurntCount, clientAudit, skippedBurnt, skippedCount: skipSet.size };
}
