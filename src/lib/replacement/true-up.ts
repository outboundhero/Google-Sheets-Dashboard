// True-up (Nick 2026-08-13): every client should sit at EXACTLY the domain
// count its tier calls for — "nothing more and nothing less".
//
//   below cap → FILL   : pull warmed reserves in until the client hits cap
//   above cap → TRIM   : untag the worst performers back into reserve
//   at cap    → nothing
//
// Today's replacement already refuses to over-fill (the TOP-UP-TO-CAP model in
// plan.ts), but it can only ever add one replacement per BURNT domain, so a
// client sitting well under cap with nothing burnt never climbs back up; and
// nothing anywhere trims a client that is over cap. This module computes both
// halves.
//
// OBSERVE-ONLY. Nothing here tags, untags, moves or deletes — it returns what
// true-up *would* do so the numbers can be checked against reality before any
// of it is wired into the auto-runner. Deliberately standalone (its own reads)
// so the live replacement path is untouched.
import { getSupabaseAdmin } from "@/lib/supabase";
import { ALL_INSTANCE_SLUGS, getInstance, type BisonInstanceSlug } from "@/lib/bison-instances";
import { pstDateString } from "@/lib/date-utils";
import { capFor, getClientTiers, type ClientTier } from "./client-tiers";
import { deriveCampaignMap, getActiveCampaignKeys, type CampaignRef } from "./campaigns";
import { getHandledDomains, getSettings } from "./store";
import { getSkipSet, skipKey } from "./skips";
import { evaluateSegments, type DomainMetrics, type ThresholdConfig } from "./threshold-groups";
import { getThresholdConfig } from "./threshold-groups-store";

const WARMUP_DAYS = 21; // matches plan.ts — a domain is usable once it's ≥ 21d old

/**
 * Tags that look like clients (they carry a tier and campaigns) but are ours,
 * not a customer's. True-up skips them entirely — `OH` alone would otherwise be
 * the single biggest trim in the system.
 *
 * Nick confirmed 2026-08-17: exclude every non-commercial-cleaning tag, which
 * is these four. They are the same four that carry empty threshold segments.
 */
export const INTERNAL_TAGS = new Set(["OH", "SC", "DM4PM", "SI"]);

export interface TrimRankingConfig {
  /**
   * Lifetime sends below which a domain counts as UNPROVEN — no track record
   * to judge it on. Unproven domains are trimmed first, ahead of anything with
   * history. Nick 2026-08-14 set this at 500: 1,000 leaves too much unrankable
   * while send rates are throttled.
   */
  minSentToTrim: number;
  /**
   * 0 = rank on reply rate alone, which is what Nick asked for. Above 0, the
   * score becomes `reply − bounceWeight × bounce`. Only here for what-ifs —
   * bounce is already its own flagging threshold, so weighting it again would
   * double-count it.
   */
  bounceWeight: number;
}

/** Defaults pending Nick's answer on the ranking metric. */
export const DEFAULT_TRIM_RANKING: TrimRankingConfig = { minSentToTrim: 500, bounceWeight: 0 };

export interface TrimCandidate {
  domain: string;
  sent: number;
  reply: number | null;   // the figure actually ranked on (30d, else 15d)
  replyWindow: "30" | "15" | null;
  bounce: number | null;
  /** Days since the domain was created — the tiebreak inside the unproven pool. */
  ageDays: number;
  /**
   * Which pass picked it. "unproven" = no track record, trimmed first;
   * "ranked" = has history and lost on reply rate. Worth showing separately —
   * a 15-day rate is noisier than a 30-day one and can look inflated next to
   * it, so it should be obvious when the two are being compared.
   */
  bucket: "unproven" | "ranked";
  score: number;
}

export interface TrueUpRow {
  clientTag: string;
  instance: BisonInstanceSlug;
  tier: ClientTier;
  cap: number;
  /** Domains that STAY — tagged, not already handled, not burnt this build. */
  staying: number;
  /** How many of those have no track record at all (the trim-first group). */
  stayingUnproven: number;
  /** Flagged burnt this build; replacement removes these on its own. */
  burnt: number;
  /** What replacement will already pull back in (its 1-per-burnt ceiling). */
  replacementPulls: number;
  /** Extra adds true-up needs ON TOP of what replacement already does. */
  fillNeeded: number;
  /** Reserve domains actually available for those adds. */
  fillCandidates: string[];
  /** fillNeeded − fillCandidates.length. > 0 = no stock for this client. */
  fillShort: number;
  /** Domains to untag back into reserve (staying − cap). */
  trimNeeded: number;
  /** In trim order, already limited to trimNeeded. */
  trimCandidates: TrimCandidate[];
  /** How many of those are unproven (no track record) rather than out-ranked. */
  trimUnproven: number;
  /** Domains on this tag that are on hold, so exempt from the trim entirely. */
  trimHeld: number;
  hasActiveCampaign: boolean;
  hasEligibleCampaign: boolean;
  /** Everything the execution runner needs, so the fill can run off this row. */
  redirectUrl: string | null;
  targetCampaigns: CampaignRef[];
  /** Why a fill can't run even where stock exists. */
  blockers: string[];
}

export interface TrueUpResult {
  generatedFor: string;
  ranking: TrimRankingConfig;
  rows: TrueUpRow[];
  totals: {
    tagsAtCap: number;
    tagsUnderCap: number;
    tagsOverCap: number;
    fillNeeded: number;
    fillAvailable: number;
    fillShort: number;
    trimNeeded: number;
  };
  /** Per instance, so it's obvious where the stock shortage actually is. */
  byInstance: Record<string, { fillNeeded: number; fillAvailable: number; fillShort: number; trimNeeded: number }>;
  /** Tags skipped and why — internal tags, no tier, no live campaign. */
  skipped: { clientTag: string; instance: string; reason: string }[];
  /**
   * Unspent reserve after the fill has earmarked what it can, keyed
   * `${instance}:${provider}`. The fill only ever draws from its own instance,
   * so an instance can sit on spare stock while another starves — this is what
   * the cross-instance move reads to find donors.
   */
  reserveLeft: Record<string, string[]>;
}

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

interface RateRow {
  instance: BisonInstanceSlug; domain: string;
  reply_10: number | null; reply_15: number | null; reply_30: number | null;
  bounce_10: number | null; bounce_15: number | null; bounce_30: number | null;
}

type Provider = "outlook" | "google" | "mixed" | "unknown";

function providerOf(d: DomRow): Provider {
  const o = d.outlook_count ?? 0, g = d.google_count ?? 0;
  if (o > 0 && g > 0) return "mixed";
  if (o > 0) return "outlook";
  if (g > 0) return "google";
  return "unknown";
}

const isInfo = (dom: string) => dom.toLowerCase().endsWith(".info");
const ageDays = (created: string | null, nowMs: number) =>
  created ? Math.floor((nowMs - new Date(created).getTime()) / 86_400_000) : 0;

export async function computeTrueUp(
  opts: { ranking?: Partial<TrimRankingConfig>; groupConfig?: ThresholdConfig } = {},
): Promise<TrueUpResult> {
  const ranking: TrimRankingConfig = { ...DEFAULT_TRIM_RANKING, ...opts.ranking };
  const supabase = getSupabaseAdmin();
  const today = pstDateString(new Date());
  const nowMs = new Date(today).getTime();

  const cfg = await getSettings();
  const groupConfig = opts.groupConfig ?? (await getThresholdConfig());
  const handled = await getHandledDomains();
  const skipSet = await getSkipSet();
  const tiers = await getClientTiers();
  // An empty tier map is a failed Client Tracker read (Sheets quota, usually
  // during the big lead sync), never reality. Computing with it would mark
  // all 147 pairs "no tier" and show every instance as covered — a report
  // that looks like success. Refuse loudly instead; the card shows this
  // message and the crons skip the tick.
  if (tiers.size === 0) {
    throw new Error(
      "Client Tracker tier read failed (Sheets quota?) — try again in a minute",
    );
  }
  const activeKeys = await getActiveCampaignKeys();
  const campaignMap = await deriveCampaignMap();

  // A tag only counts as a client tag if something else in the system knows it
  // — same rule the plan uses, so the two agree on what a "client" is.
  const redirectByTag = new Map<string, string>();
  const { data: redirectRows } = await supabase.from("client_redirects").select("client_tag,redirect_url");
  for (const r of (redirectRows || []) as { client_tag: string; redirect_url: string }[]) {
    redirectByTag.set(r.client_tag.toUpperCase(), r.redirect_url);
  }
  const knownTags = new Set<string>(redirectByTag.keys());
  const eligibleKeys = new Set<string>();
  const campaignsByKey = new Map<string, CampaignRef[]>();
  for (const m of campaignMap.matches) {
    knownTags.add(m.clientTag);
    if (m.eligible.length > 0) {
      eligibleKeys.add(`${m.clientTag}:${m.instance}`);
      campaignsByKey.set(`${m.clientTag}:${m.instance}`, m.eligible);
    }
  }
  const clientTagOf = (tags: string[] | null): string | null => {
    if (!tags) return null;
    for (const t of tags) { const u = String(t).trim().toUpperCase(); if (knownTags.has(u)) return u; }
    return null;
  };

  // 1) every domain
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

  // 2) trailing windows (PostgREST caps a single response at 1000 rows — page it)
  const rateByKey = new Map<string, RateRow>();
  let roff = 0;
  while (true) {
    const { data, error } = await supabase
      .rpc("trailing_domain_rates", { p_instances: ALL_INSTANCE_SLUGS, p_today: today })
      .range(roff, roff + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const r of data as RateRow[]) rateByKey.set(`${r.instance}:${r.domain}`, r);
    if ((data as RateRow[]).length < 1000) break;
    roff += 1000;
  }

  // 3) burnt verdict — same detector the live plan runs on
  const enriched = domains.map((d) => {
    const r = rateByKey.get(`${d.instance}:${d.domain}`);
    const m: DomainMetrics = {
      sent: d.total_sent ?? 0,
      reply_10: r?.reply_10 ?? null, reply_15: r?.reply_15 ?? null, reply_30: r?.reply_30 ?? null,
      bounce_10: r?.bounce_10 ?? null, bounce_15: r?.bounce_15 ?? null, bounce_30: r?.bounce_30 ?? null,
      surbl: d.blacklisted, spamhaus: d.spamhaus_dbl,
    };
    const skipped = skipSet.has(skipKey(d.instance, d.domain));
    const tagsUpper = new Set((d.tags || []).map((t) => String(t).trim().toUpperCase()));
    const burnt = !skipped && evaluateSegments(m, tagsUpper, groupConfig).burnt;
    return { d, m, provider: providerOf(d), tag: clientTagOf(d.tags), burnt, skipped };
  });

  // 4) reserve pools, gated exactly like plan.ts so the counts agree
  const reservePool = new Map<string, string[]>(); // `${instance}:${provider}`
  for (const e of enriched) {
    if (e.tag !== null) continue;
    if (e.provider !== "outlook" && e.provider !== "google") continue;
    if (!cfg.allowInfoReserves && isInfo(e.d.domain)) continue;
    if (ageDays(e.d.domain_created_at, nowMs) < WARMUP_DAYS) continue;
    if (e.d.spamhaus_dbl === true) continue;
    if (!cfg.allowSurblReserves && e.d.blacklisted === true) continue;
    if (e.burnt || e.skipped) continue;
    const key = `${e.d.instance}:${e.provider}`;
    if (!reservePool.has(key)) reservePool.set(key, []);
    reservePool.get(key)!.push(e.d.domain);
  }
  for (const list of reservePool.values()) list.sort();

  // 5) group the tagged, staying domains per (tag, instance)
  interface Acc {
    staying: typeof enriched;
    burnt: number;
    outlook: number;
    google: number;
  }
  const groups = new Map<string, Acc>();
  for (const e of enriched) {
    if (!e.tag) continue;
    const k = `${e.tag}:${e.d.instance}`;
    let a = groups.get(k);
    if (!a) { a = { staying: [], burnt: 0, outlook: 0, google: 0 }; groups.set(k, a); }
    if (e.burnt) { a.burnt++; continue; }
    a.staying.push(e);
    if (e.provider === "outlook") a.outlook++; else if (e.provider === "google") a.google++;
  }

  // 6) evaluate each group. Fill allocation walks the groups in a fixed order
  //    and consumes a shared pool, so two clients never claim the same reserve
  //    and `fillShort` is a real "there is nothing left for this client".
  const skipped: TrueUpResult["skipped"] = [];
  const rows: TrueUpRow[] = [];
  const orderedKeys = [...groups.keys()].sort();

  for (const key of orderedKeys) {
    const sep = key.lastIndexOf(":");
    const clientTag = key.slice(0, sep);
    const instance = key.slice(sep + 1) as BisonInstanceSlug;
    const acc = groups.get(key)!;

    if (INTERNAL_TAGS.has(clientTag)) {
      skipped.push({ clientTag, instance, reason: "internal tag — not a client" });
      continue;
    }
    const tier = tiers.get(clientTag);
    if (!tier) {
      skipped.push({ clientTag, instance, reason: "no tier in the Client Tracker" });
      continue;
    }
    const hasEligibleCampaign = eligibleKeys.has(key);
    const hasActiveCampaign = activeKeys.has(key);
    if (!hasEligibleCampaign) {
      skipped.push({ clientTag, instance, reason: "no live campaign in this instance" });
      continue;
    }

    const it = getInstance(instance).tier;
    const cap = capFor(it, tier);
    const staying = acc.staying.length;

    // What replacement already does on its own: one reserve per burnt domain,
    // never past cap. True-up only owns whatever is still missing after that.
    const replacementPulls = Math.min(acc.burnt, Math.max(0, cap - staying));
    const fillNeeded = Math.max(0, cap - staying - replacementPulls);

    // Like-for-like: follow whichever provider the client already runs on.
    const provider: "outlook" | "google" = acc.google > acc.outlook ? "google" : "outlook";
    const pool = reservePool.get(`${instance}:${provider}`) ?? [];
    const fillCandidates = pool.splice(0, fillNeeded);
    const fillShort = fillNeeded - fillCandidates.length;

    const blockers: string[] = [];
    if (fillNeeded > 0) {
      if (!redirectByTag.get(clientTag)) blockers.push("no redirect URL for tag");
      if (fillShort > 0) blockers.push(`no ready ${provider} reserve in this instance`);
      if (!hasActiveCampaign) blockers.push("no actively-sending campaign (dormant)");
    }

    // Trim, in Nick's order (2026-08-14): burnt first (replacement already does
    // that), then UNPROVEN domains, then the worst-replying proven ones.
    //
    // Unproven goes first deliberately. Protecting them inverts the whole
    // point: a client 13 over cap with 15 unproven domains would have to take
    // all 13 out of the 18 it has proof on, trading performers for unknowns
    // every cycle. An unproven domain is the cheapest thing to give up — it
    // returns to reserve with its warm-up intact and gets reassigned.
    const trimNeeded = Math.max(0, staying - cap);
    let trimCandidates: TrimCandidate[] = [];
    let trimUnproven = 0;
    let trimHeld = 0;
    let stayingUnproven = 0;
    {
      const unproven: TrimCandidate[] = [];
      const proven: TrimCandidate[] = [];
      for (const e of acc.staying) {
        // A held domain is never trimmed. Nick 2026-08-17 approved the picks
        // but reserved the right to hold one the ranking can't see a reason
        // for — a client winding down, a domain bought for something specific,
        // a campaign about to launch on it. Skips already block burnt removal
        // and reserve reuse; this extends the same hold to the trim.
        if (e.skipped) continue;
        const sent = e.d.total_sent ?? 0;
        const reply = e.m.reply_30 ?? e.m.reply_15;
        const window = e.m.reply_30 != null ? "30" : e.m.reply_15 != null ? "15" : null;
        const bounce = e.m.bounce_30 ?? e.m.bounce_15;
        // No track record = under the send floor, or no reply figure at all.
        const isUnproven = sent < ranking.minSentToTrim || reply == null;
        (isUnproven ? unproven : proven).push({
          domain: e.d.domain, sent, reply, replyWindow: window, bounce,
          ageDays: ageDays(e.d.domain_created_at, nowMs),
          bucket: isUnproven ? "unproven" : "ranked",
          // bounceWeight is 0 by default: bounce is already a flagging
          // threshold, so scoring it here would double-count it (and bounce
          // has been noisy — one connection error once spiked a whole
          // instance). Kept configurable for what-ifs only.
          score: (reply ?? 0) - ranking.bounceWeight * (bounce ?? 0),
        });
      }
      stayingUnproven = unproven.length;
      // Least-invested unproven first, then proven from the bottom up.
      //
      // The unproven pool is usually far bigger than the number to trim — a
      // client 5 over cap can have 21 domains all sitting at zero sends. Send
      // count can't separate those, so age breaks the tie: OLDEST first. A
      // domain that has had months and still sent nothing is the one that has
      // most clearly failed to get going; a three-week-old one simply hasn't
      // ramped yet and deserves to keep its slot. Without this the pick fell
      // through to alphabetical order, which is no reason at all.
      unproven.sort(
        (a, b) => a.sent - b.sent || b.ageDays - a.ageDays || a.domain.localeCompare(b.domain),
      );
      proven.sort((a, b) => a.score - b.score || a.domain.localeCompare(b.domain));
      trimCandidates = [...unproven, ...proven].slice(0, trimNeeded);
      trimUnproven = trimCandidates.filter((c) => c.bucket === "unproven").length;
      // Held domains still occupy a slot against the cap, so holding enough of
      // them can leave a client over cap with nothing left to trim. Say so
      // rather than quietly reporting a smaller trim than the row implies.
      trimHeld = acc.staying.length - (unproven.length + proven.length);
      if (trimHeld > 0 && trimCandidates.length < trimNeeded) {
        blockers.push(
          `${trimNeeded - trimCandidates.length} of the trim is held (${trimHeld} domain${trimHeld === 1 ? "" : "s"} on hold)`,
        );
      }
    }

    rows.push({
      clientTag, instance, tier, cap, staying, stayingUnproven, burnt: acc.burnt, replacementPulls,
      fillNeeded, fillCandidates, fillShort,
      trimNeeded, trimCandidates, trimUnproven, trimHeld,
      hasActiveCampaign, hasEligibleCampaign, blockers,
      redirectUrl: redirectByTag.get(clientTag) ?? null,
      targetCampaigns: campaignsByKey.get(key) ?? [],
    });
  }

  const totals = { tagsAtCap: 0, tagsUnderCap: 0, tagsOverCap: 0, fillNeeded: 0, fillAvailable: 0, fillShort: 0, trimNeeded: 0 };
  const byInstance: TrueUpResult["byInstance"] = {};
  for (const inst of ALL_INSTANCE_SLUGS) byInstance[inst] = { fillNeeded: 0, fillAvailable: 0, fillShort: 0, trimNeeded: 0 };
  for (const r of rows) {
    if (r.fillNeeded > 0) totals.tagsUnderCap++;
    else if (r.trimNeeded > 0) totals.tagsOverCap++;
    else totals.tagsAtCap++;
    totals.fillNeeded += r.fillNeeded;
    totals.fillAvailable += r.fillCandidates.length;
    totals.fillShort += r.fillShort;
    totals.trimNeeded += r.trimNeeded;
    const b = byInstance[r.instance];
    b.fillNeeded += r.fillNeeded;
    b.fillAvailable += r.fillCandidates.length;
    b.fillShort += r.fillShort;
    b.trimNeeded += r.trimNeeded;
  }

  rows.sort((a, b) =>
    (b.fillShort - a.fillShort)
    || (b.fillNeeded + b.trimNeeded) - (a.fillNeeded + a.trimNeeded)
    || a.clientTag.localeCompare(b.clientTag));

  // `fillCandidates` splices out of `reservePool`, so whatever is left here is
  // genuinely unspent after every client in that instance took its share.
  const reserveLeft: Record<string, string[]> = {};
  for (const [key, list] of reservePool) if (list.length > 0) reserveLeft[key] = [...list];

  return { generatedFor: today, ranking, rows, totals, byInstance, skipped, reserveLeft };
}
