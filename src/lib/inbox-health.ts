// Domain-level health check — the SAME rule the Deliverability page uses to
// flag domains ("Low replies" / "High bounces" chips). Extracted so the MRL
// pace cron can compute per-client infrastructure health server-side with
// numbers that always agree with what the operator sees on /deliverability.
//
// Rule (unchanged from the page):
//   - Only assess single-provider domains (pure Google or pure Outlook) with
//     more than 100 emails sent — anything else has too little signal.
//   - reply rate  < 1%  → flagged ("Low replies")
//   - bounce rate > 3%  → flagged ("High bounces")

export interface HealthCheckDomain {
  total_sent?: number | null;
  total_replied?: number | null;
  total_bounced?: number | null;
  google_count?: number | null;
  outlook_count?: number | null;
}

export const HEALTH_MIN_SENT = 100;
export const HEALTH_MIN_REPLY_RATE = 0.01;
export const HEALTH_MAX_BOUNCE_RATE = 0.03;

/** Human-readable flag reasons; empty array = not flagged (or not assessable). */
export function getDomainFlagReasons(d: HealthCheckDomain): string[] {
  const reasons: string[] = [];
  const isGoogle = (d.google_count || 0) > 0 && (d.outlook_count || 0) === 0;
  const isOutlook = (d.outlook_count || 0) > 0 && (d.google_count || 0) === 0;
  const totalSent = d.total_sent || 0;
  if (!(isGoogle || isOutlook) || totalSent <= HEALTH_MIN_SENT) return reasons;

  const replied = d.total_replied || 0;
  const bounced = d.total_bounced || 0;
  const replyRate = totalSent > 0 ? replied / totalSent : 0;
  const bounceRate = totalSent > 0 ? bounced / totalSent : 0;

  if (replyRate < HEALTH_MIN_REPLY_RATE) {
    reasons.push(`Low replies (${(replyRate * 100).toFixed(1)}% with ${totalSent.toLocaleString()} sent)`);
  }
  if (bounceRate > HEALTH_MAX_BOUNCE_RATE) {
    reasons.push(`High bounces (${(bounceRate * 100).toFixed(1)}% with ${totalSent.toLocaleString()} sent)`);
  }
  return reasons;
}

export function isDomainFlagged(d: HealthCheckDomain): boolean {
  return getDomainFlagReasons(d).length > 0;
}

/** Whether the domain has enough signal to be assessed at all. Domains below
 *  the sent minimum (or mixed-provider) are neither healthy nor flagged. */
export function isDomainAssessable(d: HealthCheckDomain): boolean {
  const isGoogle = (d.google_count || 0) > 0 && (d.outlook_count || 0) === 0;
  const isOutlook = (d.outlook_count || 0) > 0 && (d.google_count || 0) === 0;
  return (isGoogle || isOutlook) && (d.total_sent || 0) > HEALTH_MIN_SENT;
}
