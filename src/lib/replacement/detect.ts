// Burnt-domain detection — OBSERVE-ONLY. Pure evaluation + a runner that reads
// Supabase (domains + trailing rates) and returns candidates. Writes NOTHING and
// makes NO external calls. This is the foundation of the detection gate the doc
// requires to be foolproof before any automation is enabled.
import { getSupabaseAdmin } from "@/lib/supabase";
import { ALL_INSTANCE_SLUGS, type BisonInstanceSlug } from "@/lib/bison-instances";
import { pstDateString } from "@/lib/date-utils";
import type { ReplacementSettings } from "./types";

export interface DomainSignals {
  instance: BisonInstanceSlug;
  domain: string;
  totalSent: number;
  /** reply rate (%) for the chosen lookback window, null if unavailable */
  replyRate: number | null;
  /** bounce rate (%) for the chosen lookback window, null if unavailable */
  bounceRate: number | null;
  surbl: boolean | null;
  spamhaus: boolean | null;
}

export interface DetectionResult {
  burnt: boolean;
  signalsHit: string[];   // which signals fired
  reasons: string[];      // human-readable
}

/**
 * Pure guardrail evaluation. A domain is "burnt" only when it has enough volume
 * (>= minSent) AND at least `minSignals` distinct signals fire simultaneously —
 * never a single-signal trigger (per the doc's hardening requirement).
 */
export function evaluateDomain(s: DomainSignals, cfg: ReplacementSettings): DetectionResult {
  const signalsHit: string[] = [];
  const reasons: string[] = [];

  if (cfg.minReplyRate != null && s.replyRate != null && s.replyRate < cfg.minReplyRate) {
    signalsHit.push("low_reply");
    reasons.push(`reply ${s.replyRate}% < ${cfg.minReplyRate}%`);
  }
  if (cfg.maxBounceRate != null && s.bounceRate != null && s.bounceRate > cfg.maxBounceRate) {
    signalsHit.push("high_bounce");
    reasons.push(`bounce ${s.bounceRate}% > ${cfg.maxBounceRate}%`);
  }
  if (cfg.flagOnSurbl && s.surbl === true) {
    signalsHit.push("surbl");
    reasons.push("SURBL listed");
  }
  if (cfg.flagOnSpamhaus && s.spamhaus === true) {
    signalsHit.push("spamhaus");
    reasons.push("Spamhaus DBL listed");
  }

  const enoughVolume = s.totalSent >= cfg.minSent;
  const burnt = enoughVolume && signalsHit.length >= cfg.minSignals;
  if (!enoughVolume) reasons.push(`only ${s.totalSent} sent (< ${cfg.minSent}) — not judged`);
  return { burnt, signalsHit, reasons };
}

interface DomainRow {
  instance: BisonInstanceSlug;
  domain: string;
  total_sent: number | null;
  total_replied: number | null;
  total_bounced: number | null;
  blacklisted: boolean | null;
  spamhaus_dbl: boolean | null;
}

interface RateRow { instance: BisonInstanceSlug; domain: string; reply_10: number | null; reply_15: number | null; reply_30: number | null; bounce_10: number | null; bounce_15: number | null; bounce_30: number | null; }

export interface Candidate extends DetectionResult {
  instance: BisonInstanceSlug;
  domain: string;
  totalSent: number;
  replyRate: number | null;
  bounceRate: number | null;
}

/**
 * Scan assigned domains across all instances and return the burnt candidates.
 * OBSERVE-ONLY: reads Supabase only, returns results, persists nothing.
 */
export async function runDetection(cfg: ReplacementSettings): Promise<{ scanned: number; candidates: Candidate[] }> {
  const supabase = getSupabaseAdmin();
  const instances = ALL_INSTANCE_SLUGS;

  // pull domains (paginated)
  const domains: DomainRow[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("deliverability_domains")
      .select("instance,domain,total_sent,total_replied,total_bounced,blacklisted,spamhaus_dbl")
      .in("instance", instances)
      .range(offset, offset + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    domains.push(...(data as DomainRow[]));
    if (data.length < 1000) break;
    offset += 1000;
  }

  // windowed rates (only when the lookback isn't "all")
  const rateByKey = new Map<string, RateRow>();
  if (cfg.lookbackWindow !== "all") {
    const today = pstDateString(new Date());
    let roff = 0;
    while (true) {
      const { data, error } = await supabase
        .rpc("trailing_domain_rates", { p_instances: instances, p_today: today })
        .range(roff, roff + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      for (const r of data as RateRow[]) rateByKey.set(`${r.instance}:${r.domain}`, r);
      if (data.length < 1000) break;
      roff += 1000;
    }
  }

  const pick = (r: RateRow | undefined, kind: "reply" | "bounce"): number | null => {
    if (!r) return null;
    const w = cfg.lookbackWindow;
    return kind === "reply"
      ? (w === "10" ? r.reply_10 : w === "15" ? r.reply_15 : r.reply_30)
      : (w === "10" ? r.bounce_10 : w === "15" ? r.bounce_15 : r.bounce_30);
  };

  const candidates: Candidate[] = [];
  for (const d of domains) {
    const sent = d.total_sent ?? 0;
    let replyRate: number | null;
    let bounceRate: number | null;
    if (cfg.lookbackWindow === "all") {
      replyRate = sent > 0 ? Math.round(((d.total_replied ?? 0) / sent) * 1000) / 10 : null;
      bounceRate = sent > 0 ? Math.round(((d.total_bounced ?? 0) / sent) * 1000) / 10 : null;
    } else {
      const r = rateByKey.get(`${d.instance}:${d.domain}`);
      replyRate = pick(r, "reply");
      bounceRate = pick(r, "bounce");
    }
    const signals: DomainSignals = {
      instance: d.instance, domain: d.domain, totalSent: sent,
      replyRate, bounceRate, surbl: d.blacklisted, spamhaus: d.spamhaus_dbl,
    };
    const result = evaluateDomain(signals, cfg);
    if (result.burnt) {
      candidates.push({ ...result, instance: d.instance, domain: d.domain, totalSent: sent, replyRate, bounceRate });
    }
  }
  return { scanned: domains.length, candidates };
}
