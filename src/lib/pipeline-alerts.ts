// Loud-failure store for outbound pipelines (whitelist emails, sheet sync, …).
//
// A failure in any step writes/refreshes an OPEN row here AND pings Slack in
// #leadsync-outbound. The dashboard shows every open row persistently until it's
// either retried to success (auto-resolved) or manually dismissed. Nothing here
// EXECUTES a pipeline — it only records + notifies. Built so a silent 404 like
// the "EXCL: Leads" whitelist bug can never hide again.
import { getSupabaseAdmin } from "@/lib/supabase";
import { postSlackMessage } from "@/lib/slack";

export type PipelineSource = "whitelist-queue" | "send-to-sheet";

export interface PipelineAlert {
  id: string;
  source: string;
  client_tag: string | null;
  step: string;
  reason: string;
  domains: string[];
  domains_count: number;
  status: "open" | "resolved" | "dismissed";
  retry_count: number;
  created_at: string;
  updated_at: string;
  last_retry_at: string | null;
  resolved_at: string | null;
}

export interface AlertInput {
  source: PipelineSource | string;
  clientTag?: string | null;
  step: string;
  reason: string;
  domains?: string[];
}

/** Target channel for pipeline failures: #leadsync-outbound — the same channel
 *  the Outreachify bot already posts cancellations / triage resolutions to.
 *  Reuses the env var that's already set (SLACK_LEAD_SYNC_CHANNEL_ID), with the
 *  literal channel id as a last-resort fallback (same one cancel-domains uses),
 *  so no new env var is required. */
const OUTBOUND_CHANNEL = () =>
  process.env.SLACK_OUTBOUND_CHANNEL_ID ||
  process.env.SLACK_LEAD_SYNC_CHANNEL_ID ||
  "C0B84LMSVMH";

const normDomains = (domains?: string[]) =>
  [...new Set((domains || []).map((d) => d.trim().toLowerCase()).filter(Boolean))];

/**
 * Record (or refresh) an open alert for a failed step, then ping Slack.
 * Dedupes on (source, client_tag, step): a step that's still failing updates the
 * existing row instead of stacking duplicates. Slack fires on a NEW alert or when
 * the reason changes — a persistent-but-unchanged failure won't spam daily.
 */
export async function recordPipelineAlert(input: AlertInput): Promise<void> {
  const supabase = getSupabaseAdmin();
  const clientTag = input.clientTag ?? null;
  const domains = normDomains(input.domains);
  const now = new Date().toISOString();

  let q = supabase
    .from("pipeline_alerts")
    .select("id, reason")
    .eq("source", input.source)
    .eq("step", input.step)
    .eq("status", "open");
  q = clientTag === null ? q.is("client_tag", null) : q.eq("client_tag", clientTag);
  const { data: rows } = await q.limit(1);
  const existing = (rows?.[0] as { id: string; reason: string } | undefined) ?? null;

  let isNew = false;
  let reasonChanged = false;
  if (existing?.id) {
    reasonChanged = existing.reason !== input.reason;
    await supabase
      .from("pipeline_alerts")
      .update({ reason: input.reason, domains, domains_count: domains.length, updated_at: now })
      .eq("id", existing.id);
  } else {
    isNew = true;
    await supabase.from("pipeline_alerts").insert({
      source: input.source,
      client_tag: clientTag,
      step: input.step,
      reason: input.reason,
      domains,
      domains_count: domains.length,
      status: "open",
    });
  }

  if (isNew || reasonChanged) {
    await pingSlack(input, domains.length, isNew);
  }
}

async function pingSlack(input: AlertInput, count: number, isNew: boolean): Promise<void> {
  const lines = [
    ":rotating_light: *LeadSync pipeline failure*",
    `• Pipeline: \`${input.source}\``,
    `• Client: ${input.clientTag ? `*${input.clientTag}*` : "—"}`,
    `• Step: \`${input.step}\``,
    `• Domains affected: ${count}`,
    `• Reason: ${input.reason}`,
    isNew ? "" : "_(still failing on retry)_",
    "Open the LeadSync dashboard to retry or dismiss.",
  ].filter(Boolean);
  await postSlackMessage(lines.join("\n"), OUTBOUND_CHANNEL());
}

/** Every OPEN alert, oldest first — drives the persistent dashboard banner. */
export async function listOpenAlerts(): Promise<PipelineAlert[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("pipeline_alerts")
    .select("*")
    .eq("status", "open")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []) as PipelineAlert[];
}

export async function getAlert(id: string): Promise<PipelineAlert | null> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("pipeline_alerts").select("*").eq("id", id).maybeSingle();
  return (data as PipelineAlert) ?? null;
}

/** Clears open alerts for clients that fully succeeded this run (auto-recovery). */
export async function resolveAlertsForClients(source: string, clientTags: string[]): Promise<void> {
  const tags = [...new Set(clientTags)].filter(Boolean);
  if (tags.length === 0) return;
  const supabase = getSupabaseAdmin();
  await supabase
    .from("pipeline_alerts")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("source", source)
    .eq("status", "open")
    .in("client_tag", tags);
}

export async function resolveAlert(id: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  await supabase
    .from("pipeline_alerts")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("id", id);
}

export async function dismissAlert(id: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  await supabase
    .from("pipeline_alerts")
    .update({ status: "dismissed", resolved_at: new Date().toISOString() })
    .eq("id", id);
}

export async function bumpRetry(id: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const current = await getAlert(id);
  await supabase
    .from("pipeline_alerts")
    .update({ retry_count: (current?.retry_count ?? 0) + 1, last_retry_at: new Date().toISOString() })
    .eq("id", id);
}
