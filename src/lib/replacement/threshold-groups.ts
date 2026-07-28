// Per-client-tag threshold GROUPS — the "smart" burnt-domain detector Spencer
// asked for (Loom + Slack, 2026-07-20). Additive + isolated: this does NOT touch
// the existing flat `evaluateDomain` guardrails. Nothing here writes or calls
// externally — pure evaluation + an observe-only Supabase reader.
//
// Semantics (exactly per spec):
//   • Conditions INSIDE a group  → AND
//   • Groups WITHIN a segment    → OR (first matching group wins → a domain is
//     never triggered twice, and we record WHICH group fired)
//   • Segments pick the rule-set by client tag: a domain is claimed by the first
//     non-default segment whose `clientTags` includes one of the domain's tags;
//     otherwise the DEFAULT segment (commercial cleaning / janitorial) applies.
//   • Blank ≠ 0: a null/missing metric never satisfies a numeric condition, so a
//     domain with no trailing history is never flagged on that condition.
import { getSupabaseAdmin } from "@/lib/supabase";
import { ALL_INSTANCE_SLUGS, type BisonInstanceSlug } from "@/lib/bison-instances";
import { pstDateString } from "@/lib/date-utils";
import { getHandledDomains } from "./store";

// --- Model ------------------------------------------------------------------

export type MetricField =
  | "sent"
  | "reply_10" | "reply_15" | "reply_30"
  | "bounce_10" | "bounce_15" | "bounce_30"
  | "bounce_30f15"                 // bounce 30d, falling back to 15d when 30d is unavailable
  | "surbl" | "spamhaus";

export type NumericOp = "gte" | "gt" | "lte" | "lt";
export type BoolOp = "is_true" | "is_false";
export type ConditionOp = NumericOp | BoolOp;

export interface Condition {
  field: MetricField;
  op: ConditionOp;
  value?: number;                  // required for numeric ops; ignored for bool ops
}

export interface ConditionGroup {
  id: string;
  name: string;
  conditions: Condition[];         // AND
}

export interface ThresholdSegment {
  id: string;
  name: string;
  /** Uppercased client tags this segment claims. Ignored when isDefault. */
  clientTags: string[];
  /** The catch-all bucket (commercial cleaning / janitorial). Exactly one. */
  isDefault: boolean;
  groups: ConditionGroup[];        // OR
}

export interface ThresholdConfig {
  /** Master switch. While false the flat guardrails stay the source of truth. */
  enabled: boolean;
  segments: ThresholdSegment[];
  updatedAt?: string;
}

export interface DomainMetrics {
  sent: number;
  reply_10: number | null; reply_15: number | null; reply_30: number | null;
  bounce_10: number | null; bounce_15: number | null; bounce_30: number | null;
  surbl: boolean | null; spamhaus: boolean | null;
}

export interface SegmentVerdict {
  burnt: boolean;
  segmentId: string | null;
  segmentName: string | null;
  groupId: string | null;
  groupName: string | null;
  reasons: string[];
}

const NOT_BURNT: SegmentVerdict = {
  burnt: false, segmentId: null, segmentName: null, groupId: null, groupName: null, reasons: [],
};

// --- Field access + labels --------------------------------------------------

function fieldValue(m: DomainMetrics, f: MetricField): number | boolean | null {
  switch (f) {
    case "sent": return m.sent;
    case "reply_10": return m.reply_10;
    case "reply_15": return m.reply_15;
    case "reply_30": return m.reply_30;
    case "bounce_10": return m.bounce_10;
    case "bounce_15": return m.bounce_15;
    case "bounce_30": return m.bounce_30;
    case "bounce_30f15": return m.bounce_30 ?? m.bounce_15;   // 30d, else 15d
    case "surbl": return m.surbl;
    case "spamhaus": return m.spamhaus;
  }
}

const FIELD_LABEL: Record<MetricField, string> = {
  sent: "sent",
  reply_10: "reply10d", reply_15: "reply15d", reply_30: "reply30d",
  bounce_10: "bounce10d", bounce_15: "bounce15d", bounce_30: "bounce30d", bounce_30f15: "bounce30d",
  surbl: "SURBL", spamhaus: "Spamhaus",
};

const OP_SYMBOL: Record<ConditionOp, string> = {
  gte: "≥", gt: ">", lte: "≤", lt: "<", is_true: "listed", is_false: "clean",
};

function isPercentField(f: MetricField): boolean {
  return f.startsWith("reply") || f.startsWith("bounce");
}

// --- Pure evaluation --------------------------------------------------------

function evalCondition(m: DomainMetrics, c: Condition): boolean {
  const v = fieldValue(m, c.field);
  if (c.op === "is_true") return v === true;
  if (c.op === "is_false") return v === false;
  // numeric — blank ≠ 0: a null/undefined metric never satisfies the condition
  if (typeof v !== "number") return false;
  if (c.value == null || Number.isNaN(c.value)) return false;
  switch (c.op) {
    case "gte": return v >= c.value;
    case "gt": return v > c.value;
    case "lte": return v <= c.value;
    case "lt": return v < c.value;
  }
}

function describe(m: DomainMetrics, c: Condition): string {
  const label = FIELD_LABEL[c.field];
  if (c.op === "is_true") return `${label} listed`;
  if (c.op === "is_false") return `${label} clean`;
  const raw = fieldValue(m, c.field);
  const shown = typeof raw === "number"
    ? (isPercentField(c.field) ? `${raw}%` : raw.toLocaleString())
    : "—";
  const target = isPercentField(c.field) ? `${c.value}%` : (c.value ?? 0).toLocaleString();
  return `${label} ${shown} ${OP_SYMBOL[c.op]} ${target}`;
}

/** Which segment governs a domain, given its (uppercased) tag set. */
export function segmentForTags(
  tagsUpper: Set<string>,
  segments: ThresholdSegment[],
): ThresholdSegment | null {
  for (const seg of segments) {
    if (seg.isDefault) continue;
    if (seg.clientTags.some((t) => tagsUpper.has(t.toUpperCase()))) return seg;
  }
  return segments.find((s) => s.isDefault) ?? null;
}

/**
 * Evaluate one domain against the segmented groups. Returns the FIRST group that
 * fully matches (OR semantics + single-trigger dedupe), recording which segment
 * and group fired. A segment with no groups → never burnt.
 */
export function evaluateSegments(
  m: DomainMetrics,
  tagsUpper: Set<string>,
  cfg: ThresholdConfig,
): SegmentVerdict {
  if (!cfg.enabled) return NOT_BURNT;
  const seg = segmentForTags(tagsUpper, cfg.segments);
  if (!seg || seg.groups.length === 0) return NOT_BURNT;
  for (const g of seg.groups) {
    if (g.conditions.length === 0) continue;                 // empty group never matches
    const reasons: string[] = [];
    let all = true;
    for (const c of g.conditions) {
      if (!evalCondition(m, c)) { all = false; break; }
      reasons.push(describe(m, c));
    }
    if (all) {
      return { burnt: true, segmentId: seg.id, segmentName: seg.name, groupId: g.id, groupName: g.name, reasons };
    }
  }
  return NOT_BURNT;
}

// --- Default seed (Spencer's exact cleaning thresholds) ---------------------

/** The starting config: cleaning/janitorial defaults + the four excluded tags
 *  carved out as their own (empty) segments. `enabled: false` — staged, not live. */
export function defaultThresholdConfig(): ThresholdConfig {
  return {
    enabled: false,
    segments: [
      {
        id: "seg-default",
        name: "Commercial cleaning / janitorial (default)",
        clientTags: [],
        isDefault: true,
        groups: [
          {
            id: "grp-g1", name: "500–1,499 sent",
            conditions: [
              { field: "sent", op: "gte", value: 500 },
              { field: "sent", op: "lt", value: 1500 },
              { field: "reply_15", op: "lt", value: 1.5 },
              { field: "reply_30", op: "lt", value: 1.5 },
            ],
          },
          {
            id: "grp-g2", name: "1,500–4,499 sent",
            conditions: [
              { field: "sent", op: "gte", value: 1500 },
              { field: "sent", op: "lt", value: 4500 },
              { field: "reply_15", op: "lt", value: 1.6 },
              { field: "reply_30", op: "lt", value: 1.6 },
            ],
          },
          {
            id: "grp-g3", name: "4,500–4,999 sent",
            conditions: [
              { field: "sent", op: "gte", value: 4500 },
              { field: "sent", op: "lt", value: 5000 },
              { field: "reply_15", op: "lt", value: 1.4 },
              { field: "reply_30", op: "lt", value: 1.4 },
            ],
          },
          {
            id: "grp-g4", name: "5,000+ sent",
            conditions: [
              { field: "sent", op: "gte", value: 5000 },
              { field: "reply_15", op: "lt", value: 1.2 },
              { field: "reply_30", op: "lt", value: 1.2 },
            ],
          },
          {
            id: "grp-g5", name: "High bounce",
            conditions: [
              { field: "sent", op: "gte", value: 200 },
              { field: "bounce_30f15", op: "gt", value: 8 },
            ],
          },
        ],
      },
      { id: "seg-sc", name: "SC", clientTags: ["SC"], isDefault: false, groups: [] },
      { id: "seg-oh", name: "OH (Outbound Hero internal)", clientTags: ["OH"], isDefault: false, groups: [] },
      { id: "seg-dm4pm", name: "DM4PM", clientTags: ["DM4PM"], isDefault: false, groups: [] },
      { id: "seg-si", name: "SI (Insurance)", clientTags: ["SI"], isDefault: false, groups: [] },
    ],
  };
}

// --- Observe-only runner ----------------------------------------------------

interface DomRow {
  instance: BisonInstanceSlug;
  domain: string;
  tags: string[] | null;
  total_sent: number | null;
  total_replied: number | null;
  total_bounced: number | null;
  blacklisted: boolean | null;
  spamhaus_dbl: boolean | null;
}
interface RateRow {
  instance: BisonInstanceSlug; domain: string;
  reply_10: number | null; reply_15: number | null; reply_30: number | null;
  bounce_10: number | null; bounce_15: number | null; bounce_30: number | null;
}

export interface GroupCandidate {
  instance: BisonInstanceSlug;
  domain: string;
  clientTag: string | null;
  sent: number;
  reply_15: number | null;
  reply_30: number | null;
  bounce_30f15: number | null;
  segmentId: string;
  segmentName: string;
  groupId: string;
  groupName: string;
  reasons: string[];
}

/**
 * Scan every assigned domain and return the burnt candidates under the segmented
 * groups. OBSERVE-ONLY: reads Supabase only, persists nothing, calls nothing.
 */
export async function runGroupDetection(
  cfg: ThresholdConfig,
): Promise<{ scanned: number; candidates: GroupCandidate[] }> {
  if (!cfg.enabled) return { scanned: 0, candidates: [] };
  const supabase = getSupabaseAdmin();
  const instances = ALL_INSTANCE_SLUGS;
  const handled = await getHandledDomains();

  // known client tags (redirects ∪ campaigns) — to display each domain's tag
  const knownTags = new Set<string>();
  const [{ data: redir }, { data: camps }] = await Promise.all([
    supabase.from("client_redirects").select("client_tag"),
    supabase.from("campaigns").select("client_tag"),
  ]);
  for (const r of (redir || []) as { client_tag: string | null }[]) if (r.client_tag) knownTags.add(r.client_tag.toUpperCase());
  for (const c of (camps || []) as { client_tag: string | null }[]) if (c.client_tag) knownTags.add(c.client_tag.toUpperCase());
  const clientTagOf = (tags: string[] | null): string | null => {
    if (!tags) return null;
    for (const t of tags) { const u = String(t).trim().toUpperCase(); if (knownTags.has(u)) return u; }
    return null;
  };

  // domains (paginated)
  const domains: DomRow[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("deliverability_domains")
      .select("instance,domain,tags,total_sent,total_replied,total_bounced,blacklisted,spamhaus_dbl")
      .in("instance", instances)
      .range(offset, offset + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const d of data as DomRow[]) if (!handled.has(`${d.instance}:${d.domain}`)) domains.push(d);
    if (data.length < 1000) break;
    offset += 1000;
  }

  // trailing windows (always — the groups are window-based)
  const rateByKey = new Map<string, RateRow>();
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

  const candidates: GroupCandidate[] = [];
  for (const d of domains) {
    const r = rateByKey.get(`${d.instance}:${d.domain}`);
    const m: DomainMetrics = {
      sent: d.total_sent ?? 0,
      reply_10: r?.reply_10 ?? null, reply_15: r?.reply_15 ?? null, reply_30: r?.reply_30 ?? null,
      bounce_10: r?.bounce_10 ?? null, bounce_15: r?.bounce_15 ?? null, bounce_30: r?.bounce_30 ?? null,
      surbl: d.blacklisted, spamhaus: d.spamhaus_dbl,
    };
    const tagsUpper = new Set((d.tags || []).map((t) => String(t).trim().toUpperCase()));
    const verdict = evaluateSegments(m, tagsUpper, cfg);
    if (verdict.burnt) {
      candidates.push({
        instance: d.instance, domain: d.domain, clientTag: clientTagOf(d.tags),
        sent: m.sent, reply_15: m.reply_15, reply_30: m.reply_30,
        bounce_30f15: m.bounce_30 ?? m.bounce_15,
        segmentId: verdict.segmentId!, segmentName: verdict.segmentName!,
        groupId: verdict.groupId!, groupName: verdict.groupName!,
        reasons: verdict.reasons,
      });
    }
  }
  return { scanned: domains.length, candidates };
}
