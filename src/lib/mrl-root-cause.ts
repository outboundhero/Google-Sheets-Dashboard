// Root-cause diagnostic engine for off-pace clients (MRL Pacing v2).
//
// Ordered checks — first strong hit wins, because an upstream failure
// invalidates everything downstream (e.g. with 12K contacts loaded, inbox
// health is irrelevant until volume is fixed). Order per the client's spec:
//
//   1. Insufficient contact volume  (< 25K total contacts across all campaigns)
//   2. Low healthy sending capacity (healthy/total sender accounts < 60%)
//   3. Nurture routing gap          (no live [Nurture] campaigns for the tag)
//   4. Failed campaign(s) detected
//   5. Leads flowing, low conversion (fallback — pipeline exists, not producing)
//
// Confidence is DERIVED, not guessed:
//   High   — exactly one check hit and no other check is borderline
//   Medium — multiple hits, or the winning hit has borderline company
//
// Only runs for at_risk / critical clients. All inputs come pre-aggregated
// from the cron (synced Supabase tables — zero live Bison calls).

export type RootCauseTag =
  | "insufficient_contact_volume"
  | "low_sending_capacity"
  | "nurture_routing_gap"
  | "failed_campaigns"
  | "low_conversion";

export type RootCauseConfidence = "high" | "medium";

// Tuning knobs (exported for visibility).
export const MIN_CONTACT_VOLUME = 25_000;
export const CONTACT_VOLUME_BORDERLINE = 35_000;
export const MIN_HEALTHY_RATIO = 0.6;
export const HEALTHY_RATIO_BORDERLINE = 0.75;

export interface RootCauseInputs {
  /** Σ total_leads across ALL the client's non-archived campaigns, every instance. */
  totalContacts: number;
  /** Sender accounts carrying the client's tag: healthy = not disconnected-like
   *  AND not on a flagged domain. */
  healthyAccounts: number;
  totalAccounts: number;
  /** Non-archived campaigns whose name contains "[Nurture]" for this tag. */
  nurtureCampaigns: number;
  /** Campaigns for this tag whose synced status is "failed". */
  failedCampaigns: number;
}

export interface RootCauseResult {
  tag: RootCauseTag;
  /** Human-readable label with interpolated numbers, per the spec's tag format. */
  detail: string;
  confidence: RootCauseConfidence;
}

interface CheckOutcome {
  hit: boolean;
  borderline: boolean;
  tag: RootCauseTag;
  detail: string;
}

export function diagnoseRootCause(s: RootCauseInputs): RootCauseResult {
  const healthyRatio = s.totalAccounts > 0 ? s.healthyAccounts / s.totalAccounts : 1;

  const checks: CheckOutcome[] = [
    {
      tag: "insufficient_contact_volume",
      hit: s.totalContacts < MIN_CONTACT_VOLUME,
      borderline:
        s.totalContacts >= MIN_CONTACT_VOLUME && s.totalContacts < CONTACT_VOLUME_BORDERLINE,
      detail: `Insufficient contact volume (${s.totalContacts.toLocaleString()} loaded, <25K)`,
    },
    {
      tag: "low_sending_capacity",
      hit: s.totalAccounts > 0 && healthyRatio < MIN_HEALTHY_RATIO,
      borderline:
        s.totalAccounts > 0 &&
        healthyRatio >= MIN_HEALTHY_RATIO &&
        healthyRatio < HEALTHY_RATIO_BORDERLINE,
      detail: `Low healthy sending capacity (${s.healthyAccounts}/${s.totalAccounts} healthy)`,
    },
    {
      tag: "nurture_routing_gap",
      hit: s.nurtureCampaigns === 0,
      borderline: s.nurtureCampaigns === 1,
      detail: `Nurture routing gap (no live [Nurture] campaigns)`,
    },
    {
      tag: "failed_campaigns",
      hit: s.failedCampaigns > 0,
      borderline: false,
      detail: `Failed campaign(s) detected (${s.failedCampaigns})`,
    },
  ];

  const hits = checks.filter((c) => c.hit);
  const borderlines = checks.filter((c) => !c.hit && c.borderline);

  if (hits.length === 0) {
    // Everything upstream is clean but the client is still behind — the
    // pipeline exists but isn't producing. Work-the-leads bucket.
    return {
      tag: "low_conversion",
      detail: "Leads flowing, low conversion",
      confidence: borderlines.length > 0 ? "medium" : "high",
    };
  }

  const winner = hits[0]; // ordered array → first hit wins
  const confidence: RootCauseConfidence =
    hits.length === 1 && borderlines.length === 0 ? "high" : "medium";

  return { tag: winner.tag, detail: winner.detail, confidence };
}
