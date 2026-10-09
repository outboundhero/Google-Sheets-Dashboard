// Turbo preview — what activating Turbo would change for one client, and a
// rough read on whether it would move the needle, so whoever clicks sees it
// before anything touches Bison. Read-only: nothing here writes.
//
//   where it stands   the last evaluation (as of the Friday cut-off) and the
//                     credit band the period is heading for
//   what changes      connected accounts per instance, how many get raised to
//                     the Turbo limit and how many are already at/above it
//                     (those are left alone — windows.ts only raises)
//   sends per day     account capacity now vs in Turbo, capped by the
//                     client's active campaigns' daily caps
//   estimate          extra emails inside this billing period ÷ the client's
//                     own emails-per-QL history = extra QLs. Rough on purpose:
//                     replies land days after the send, and lifetime history
//                     includes old sequences.
//   watch-outs        anything that makes Turbo pointless or risky
import { getSupabaseAdmin } from "@/lib/supabase";
import { getStoredLeads } from "@/lib/leads-store";
import { getInstance, isInstanceSlug } from "@/lib/bison-instances";
import { isQualityLead } from "@/lib/cron/client-reports";
import { getSendingModeSettings, type SendingModeSettings } from "./config";
import { lastStatusCutoff } from "./ql-pace";
import { getOpenWindow, loadClientAccounts, type SendingWindow } from "./windows";

export type CreditBand = "target_met" | "credit_50" | "credit_100";

export interface TurboPreview {
  clientTag: string;
  companyName: string | null;
  settings: SendingModeSettings;
  endsAt: string;
  open: SendingWindow | null;
  standing: {
    status: string;
    judgedAt: string;
    qlsDelivered: number;
    guarantee: number;
    projected: number;
    band: CreditBand;
    cycleEnd: string;
    daysRemaining: number;
  } | null;
  accounts: {
    total: number;
    byInstance: { label: string; count: number }[];
    raised: number;          // below the Turbo limit → raised to it
    unchanged: number;       // already at/above it → left alone
  };
  perDay: {
    now: number;             // what the accounts + campaign caps allow today
    turbo: number;
    extra: number;
    campaignCap: number | null;
    activeCampaigns: number;
    uncontactedLeads: number;
  };
  estimate: {
    turboDaysInPeriod: number;
    extraEmailsInPeriod: number;
    emailsPerQl: number | null;
    extraQls: number | null;
    projectedWithTurbo: number | null;
    bandWithTurbo: CreditBand | null;
  };
  warnings: string[];
}

const SENDING = new Set(["active", "launching", "launch processing"]);
const MIN_QLS_FOR_RATE = 3;

export function creditBand(qls: number, guarantee: number, fullCreditFraction: number): CreditBand {
  if (qls >= guarantee) return "target_met";
  return qls <= guarantee * fullCreditFraction ? "credit_100" : "credit_50";
}

export async function buildTurboPreview(clientTag: string): Promise<TurboPreview> {
  const tag = clientTag.trim().toUpperCase();
  const supabase = getSupabaseAdmin();
  const [settings, accounts, open, { data: st }, { data: camps }, leads] = await Promise.all([
    getSendingModeSettings(),
    loadClientAccounts(tag, false),
    getOpenWindow(tag),
    supabase.from("client_sending_status").select("*").eq("client_tag", tag).maybeSingle(),
    supabase.from("campaigns").select("status, emails_sent, max_emails_per_day, remaining_leads").eq("client_tag", tag),
    getStoredLeads(),
  ]);

  const endsAt = new Date(Date.now() + settings.turboDays * 86_400_000).toISOString();
  const T = settings.turboDailyLimit;

  // ── accounts ────────────────────────────────────────────────────────────
  const byInstanceMap = new Map<string, number>();
  let nowCapacity = 0, turboCapacity = 0, raised = 0;
  for (const s of accounts.senders) {
    const label = isInstanceSlug(s.instance) ? getInstance(s.instance).label.split("–").pop()!.trim() : s.instance;
    byInstanceMap.set(label, (byInstanceMap.get(label) ?? 0) + 1);
    nowCapacity += s.dailyLimit;
    turboCapacity += Math.max(s.dailyLimit, T);
    if (s.dailyLimit < T) raised++;
  }

  // ── campaigns ───────────────────────────────────────────────────────────
  const rows = (camps || []) as { status: string | null; emails_sent: number | null; max_emails_per_day: number | null; remaining_leads: number | null }[];
  const active = rows.filter((c) => SENDING.has(String(c.status || "").toLowerCase()));
  const caps = active.map((c) => Number(c.max_emails_per_day || 0));
  const campaignCap = active.length && caps.every((c) => c > 0) ? caps.reduce((a, b) => a + b, 0) : null;
  const uncontactedLeads = active.reduce((s, c) => s + Math.max(0, Number(c.remaining_leads || 0)), 0);
  const ceiling = (n: number) => (campaignCap === null ? n : Math.min(n, campaignCap));
  const perNow = active.length ? ceiling(nowCapacity) : 0;
  const perTurbo = active.length ? ceiling(turboCapacity) : 0;
  const extraPerDay = Math.max(0, perTurbo - perNow);

  // ── standing + estimate ─────────────────────────────────────────────────
  const standing = st
    ? {
        status: String(st.status),
        judgedAt: lastStatusCutoff(new Date(String(st.evaluated_at))).toISOString(),
        qlsDelivered: Number(st.qls_delivered),
        guarantee: Number(st.guarantee),
        projected: Number(st.projected ?? 0),
        band: creditBand(Number(st.projected ?? 0), Number(st.guarantee), settings.fullCreditFraction),
        cycleEnd: String(st.cycle_end),
        daysRemaining: Number(st.days_remaining),
      }
    : null;

  const clientLeads = leads.filter((l) => (l.sheetClientTag || l.clientTag || "").split(":")[0].trim().toUpperCase() === tag);
  const qlsEver = clientLeads.filter(isQualityLead).length;
  const emailsEver = rows.reduce((s, c) => s + Number(c.emails_sent || 0), 0);
  const emailsPerQl = qlsEver >= MIN_QLS_FOR_RATE && emailsEver > 0 ? Math.round(emailsEver / qlsEver) : null;

  const turboDaysInPeriod = standing ? Math.min(settings.turboDays, standing.daysRemaining) : settings.turboDays;
  const extraEmailsInPeriod = extraPerDay * turboDaysInPeriod;
  const extraQls = emailsPerQl ? Math.round((extraEmailsInPeriod / emailsPerQl) * 10) / 10 : null;
  const projectedWithTurbo = standing && extraQls !== null ? Math.round(standing.projected + extraQls) : null;

  // ── watch-outs ──────────────────────────────────────────────────────────
  const warnings: string[] = [];
  if (accounts.senders.length === 0) warnings.push("No connected accounts carry this tag — Turbo has nothing to change.");
  if (active.length === 0) warnings.push("No campaign is sending for this client — Turbo changes nothing until one is.");
  if (standing?.status === "no_data") warnings.push("The Status column is mostly blank for this client, so its QLs can't be counted — the QL estimate below is a guess.");
  if (emailsPerQl === null && standing?.status !== "no_data") warnings.push("Not enough QL history to estimate extra QLs.");
  if (active.length && campaignCap !== null && campaignCap <= nowCapacity) warnings.push(`The campaigns' daily caps (${campaignCap.toLocaleString()}/day) are already the limit — Turbo won't add emails unless the caps are raised.`);
  if (extraPerDay > 0 && uncontactedLeads < extraPerDay * settings.turboDays) warnings.push(`Only ${uncontactedLeads.toLocaleString()} uncontacted leads left in sending campaigns — the extra emails may run them out before Turbo ends.`);
  if (raised === 0 && accounts.senders.length > 0) warnings.push(`Every account is already at ${T}/day or more — only the warm-up change applies.`);
  if (standing && settings.turboDays > standing.daysRemaining) warnings.push(`Turbo runs to ${endsAt.slice(0, 10)}, past the end of this billing period (${standing.cycleEnd}) — the last ${settings.turboDays - standing.daysRemaining} day(s) count toward next period.`);
  if (open?.kind === "throttle") warnings.push("The active throttle is released first.");
  if (open?.kind === "turbo") warnings.push("Turbo is already on for this client.");

  return {
    clientTag: tag,
    companyName: (st?.company_name as string | null) ?? null,
    settings,
    endsAt,
    open,
    standing,
    accounts: {
      total: accounts.senders.length,
      byInstance: [...byInstanceMap].map(([label, count]) => ({ label, count })),
      raised,
      unchanged: accounts.senders.length - raised,
    },
    perDay: { now: perNow, turbo: perTurbo, extra: extraPerDay, campaignCap, activeCampaigns: active.length, uncontactedLeads },
    estimate: {
      turboDaysInPeriod,
      extraEmailsInPeriod,
      emailsPerQl,
      extraQls,
      projectedWithTurbo,
      bandWithTurbo: standing && projectedWithTurbo !== null ? creditBand(projectedWithTurbo, standing.guarantee, settings.fullCreditFraction) : null,
    },
    warnings,
  };
}
