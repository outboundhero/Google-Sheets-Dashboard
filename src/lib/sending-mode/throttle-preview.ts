// Auto-throttle preview — what the next daily throttle pass would do, client
// by client, and what it would cost in sends and (roughly) QLs. Read-only:
// the decisions come from the same decideThrottles() the pass runs, on the
// rows the hourly cron last wrote.
//
// Unlike the Turbo preview (one client, live from Bison), this covers every
// client the pass would touch, so account limits come from the dashboard's
// copy of Bison (deliverability_inboxes, refreshed by the deliverability
// crawl) — close enough for a preview; the real pass reads Bison live.
import { getSupabaseAdmin } from "@/lib/supabase";
import { getStoredLeads } from "@/lib/leads-store";
import { ALL_INSTANCE_SLUGS } from "@/lib/bison-instances";
import { isQualityLead } from "@/lib/cron/client-reports";
import { getSendingModeSettings, type SendingModeSettings } from "./config";
import { lastStatusCutoff, type QlPaceStatus } from "./ql-pace";
import { decideThrottles, getThrottlePausedSet, type ClientSendingStatus } from "./status";
import { listOpenWindows } from "./windows";

export const THROTTLE_HOUR_UTC = 17;

export interface ThrottlePreviewRow {
  clientTag: string;
  companyName: string | null;
  reason: string;
  pace: number | null;
  qlsDelivered: number;
  guarantee: number;
  projected: number;
  daysRemaining: number;
  accounts: number;
  lowered: number;            // accounts above the throttle limit → lowered to it
  perDayNow: number;
  perDayThrottled: number;
  fewerPerDay: number;
  emailsPerQl: number | null;
  qlsGivenUp: number | null;  // if it stays throttled to the end of the period
  projectedAfter: number | null;
}

export interface ThrottlePreview {
  enabled: boolean;
  nextPassAt: string;
  judgedAt: string | null;
  settings: SendingModeSettings;
  throttle: ThrottlePreviewRow[];
  release: { clientTag: string; reason: string }[];
  leftAlone: { clientTag: string; reason: string }[];
}

const SENDING = new Set(["active", "launching", "launch processing"]);
const MIN_QLS_FOR_RATE = 3;
const disconnected = (status: string | null) => /disconnect|reconnection|login failed|auth failed|not connected/i.test(String(status || ""));

function nextPass(now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), THROTTLE_HOUR_UTC));
  if (d <= now) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/** `rows` overrides the stored evaluation (e.g. a fresh evaluateAllClients()). */
export async function buildThrottlePreview(opts: { rows?: ClientSendingStatus[] } = {}): Promise<ThrottlePreview> {
  const supabase = getSupabaseAdmin();
  const [settings, { data: statusRows, error }, open, paused] = await Promise.all([
    getSendingModeSettings(),
    opts.rows ? Promise.resolve({ data: [], error: null }) : supabase.from("client_sending_status").select("*"),
    listOpenWindows(),
    getThrottlePausedSet(),
  ]);
  if (error) throw new Error(error.message);

  const rows: ClientSendingStatus[] = opts.rows?.filter((r) => r.gone === null) ?? ((statusRows || []) as Record<string, unknown>[]).map((r) => ({
    clientTag: String(r.client_tag).toUpperCase(),
    companyName: (r.company_name as string | null) ?? "",
    plan: (r.plan as string | null) ?? "",
    trackerStatus: (r.tracker_status as string | null) ?? "",
    leavingOn: (r.leaving_on as string | null) ?? null,
    leavingKind: (r.leaving_kind as "churn" | "pause" | null) ?? null,
    gone: null,
    guarantee: Number(r.guarantee),
    cycleStart: String(r.cycle_start),
    cycleEnd: String(r.cycle_end),
    cycleLength: Number(r.cycle_length),
    daysElapsed: Number(r.days_elapsed),
    daysRemaining: Number(r.days_remaining),
    qlsDelivered: Number(r.qls_delivered),
    expectedToDate: Number(r.expected_to_date),
    pace: r.pace === null || r.pace === undefined ? null : Number(r.pace),
    projected: Number(r.projected ?? 0),
    status: String(r.status) as QlPaceStatus,
    judgedAt: lastStatusCutoff(new Date(String(r.evaluated_at))).toISOString(),
    repliesToDate: 0,
    blankStatusToDate: 0,
  }));
  const byTag = new Map(rows.map((r) => [r.clientTag, r]));
  const decisions = decideThrottles(rows, open, paused, settings);

  const toThrottle = decisions.filter((d) => d.action === "throttle");
  const release = decisions.filter((d) => d.action === "release").map((d) => ({ clientTag: d.clientTag, reason: d.reason }));
  // Over the line but the pass leaves them alone — say why, so nobody wonders.
  const leftAlone = decisions
    .filter((d) => d.action === "none" && d.status === "overperforming")
    .map((d) => ({ clientTag: d.clientTag, reason: d.reason }));

  const tags = toThrottle.map((d) => d.clientTag);
  const [leads, { data: camps }] = await Promise.all([
    tags.length ? getStoredLeads() : Promise.resolve([]),
    tags.length
      ? supabase.from("campaigns").select("client_tag, status, emails_sent, max_emails_per_day").in("client_tag", tags)
      : Promise.resolve({ data: [] }),
  ]);

  const out: ThrottlePreviewRow[] = [];
  for (const d of toThrottle) {
    const r = byTag.get(d.clientTag)!;

    // Accounts: every connected inbox on a domain carrying the client tag.
    const { data: doms } = await supabase
      .from("deliverability_domains").select("instance, domain")
      .in("instance", ALL_INSTANCE_SLUGS).contains("tags", [d.clientTag]);
    const domList = (doms || []) as { instance: string; domain: string }[];
    const keys = new Set(domList.map((x) => `${x.instance}:${x.domain}`));
    const limits: number[] = [];
    const names = [...new Set(domList.map((x) => x.domain))];
    // ~50 inboxes a domain: page every slice, a single read stops at 1,000 rows.
    for (let i = 0; i < names.length; i += 50) {
      for (let off = 0; ; off += 1000) {
        const { data: ib, error: e } = await supabase
          .from("deliverability_inboxes").select("instance, domain, status, daily_limit")
          .in("domain", names.slice(i, i + 50)).order("id").range(off, off + 999);
        if (e) throw new Error(e.message);
        for (const x of (ib || []) as { instance: string; domain: string; status: string | null; daily_limit: number | null }[]) {
          if (keys.has(`${x.instance}:${x.domain}`) && !disconnected(x.status)) limits.push(Number(x.daily_limit ?? 0));
        }
        if (!ib || ib.length < 1000) break;
      }
    }
    const T = settings.throttleDailyLimit;
    const capNow = limits.reduce((s, l) => s + l, 0);
    const capThrottled = limits.reduce((s, l) => s + Math.min(l, T), 0);

    const mine = ((camps || []) as { client_tag: string | null; status: string | null; emails_sent: number | null; max_emails_per_day: number | null }[])
      .filter((c) => String(c.client_tag || "").trim().toUpperCase() === d.clientTag);
    const active = mine.filter((c) => SENDING.has(String(c.status || "").toLowerCase()));
    const caps = active.map((c) => Number(c.max_emails_per_day || 0));
    const campaignCap = active.length && caps.every((c) => c > 0) ? caps.reduce((a, b) => a + b, 0) : null;
    const ceiling = (n: number) => (!active.length ? 0 : campaignCap === null ? n : Math.min(n, campaignCap));
    const perDayNow = ceiling(capNow);
    const perDayThrottled = ceiling(capThrottled);
    const fewerPerDay = Math.max(0, perDayNow - perDayThrottled);

    const qlsEver = leads.filter((l) => (l.sheetClientTag || l.clientTag || "").split(":")[0].trim().toUpperCase() === d.clientTag && isQualityLead(l)).length;
    const emailsEver = mine.reduce((s, c) => s + Number(c.emails_sent || 0), 0);
    const emailsPerQl = qlsEver >= MIN_QLS_FOR_RATE && emailsEver > 0 ? Math.round(emailsEver / qlsEver) : null;
    const qlsGivenUp = emailsPerQl ? Math.round(((fewerPerDay * r.daysRemaining) / emailsPerQl) * 10) / 10 : null;

    out.push({
      clientTag: d.clientTag,
      companyName: r.companyName || null,
      reason: d.reason,
      pace: r.pace,
      qlsDelivered: r.qlsDelivered,
      guarantee: r.guarantee,
      projected: r.projected,
      daysRemaining: r.daysRemaining,
      accounts: limits.length,
      lowered: limits.filter((l) => l > T).length,
      perDayNow,
      perDayThrottled,
      fewerPerDay,
      emailsPerQl,
      qlsGivenUp,
      // QLs already delivered stay delivered — the estimate can't go below them.
      projectedAfter: qlsGivenUp === null ? null : Math.max(r.qlsDelivered, Math.round(r.projected - qlsGivenUp)),
    });
  }
  out.sort((a, b) => (b.pace ?? 0) - (a.pace ?? 0));

  const judgedAt = rows.reduce<string | null>((m, r) => (!m || r.judgedAt > m ? r.judgedAt : m), null);
  return {
    enabled: process.env.SENDING_MODE_THROTTLE_ENABLED === "true",
    nextPassAt: nextPass().toISOString(),
    judgedAt,
    settings,
    throttle: out,
    release,
    leftAlone,
  };
}
