// Deferred re-attach queue (Spencer's Loom 2026-07-21): Bison silently ignores
// adding accounts to a campaign that's queued / launching / launch processing —
// so any attach that failed, stayed rate-limited, or hit a campaign in one of
// those states is queued here and re-run by cron 8 HOURS later (repeating, max
// 6 attempts ≈ 48h). Re-attaching is idempotent: the route filters
// already-attached inboxes server-side.
import { getSupabaseAdmin } from "@/lib/supabase";
import { logEvents } from "./store";
import { normStatus } from "./campaigns";

const DEFER_HOURS = 8;
const MAX_ATTEMPTS = 6;

/** Campaign states in which Bison ignores account adds (per Spencer). */
const DEFERRED_STATUSES = new Set(["queued", "launching", "launch processing"]);

export interface AttachOutcome {
  instance: string;
  campaignId: number;
  campaignName?: string | null;
  clientTag?: string | null;
  domains: string[];
  ok: boolean;                   // did the attach call itself succeed
  remainingRateLimited?: number; // rate-limited inboxes left after the runner's retries
}

function nextAt(): string {
  return new Date(Date.now() + DEFER_HOURS * 3600_000).toISOString();
}

async function enqueue(o: AttachOutcome, reason: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("replacement_attach_queue").insert({
    instance: o.instance,
    campaign_id: o.campaignId,
    campaign_name: o.campaignName ?? null,
    client_tag: o.clientTag ?? null,
    domains: o.domains,
    reason,
    status: "pending",
    attempts: 0,
    next_attempt_at: nextAt(),
  });
  if (error) throw new Error(error.message);
}

/**
 * Called after every attach the runner performs. Defers a re-attach when the
 * call failed / left rate-limited inboxes, or when the campaign is currently
 * in a state where Bison ignores adds. Returns the defer reason (null = fine).
 */
export async function maybeDeferReattach(o: AttachOutcome): Promise<string | null> {
  let reason: string | null = null;
  if (!o.ok) reason = "attach failed — will re-try in 8h";
  else if ((o.remainingRateLimited ?? 0) > 0) reason = `${o.remainingRateLimited} inbox(es) still rate-limited — re-try in 8h`;
  else {
    const supabase = getSupabaseAdmin();
    const { data } = await supabase
      .from("campaigns")
      .select("status")
      .eq("instance", o.instance)
      .eq("id", o.campaignId)
      .maybeSingle();
    const st = normStatus(data?.status);
    if (DEFERRED_STATUSES.has(st)) reason = `campaign is "${st}" — Bison may ignore adds; verifying in 8h`;
  }
  if (reason) await enqueue(o, reason);
  return reason;
}

export interface ProcessResult {
  due: number;
  completed: number;
  rescheduled: number;
  exhausted: number;
}

/** Cron worker: re-run every due attach by invoking the attach route handler
 *  directly (same code path as the UI — no logic fork, no session needed). */
export async function processDueReattaches(): Promise<ProcessResult> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("replacement_attach_queue")
    .select("*")
    .eq("status", "pending")
    .lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at", { ascending: true })
    .limit(20);
  if (error) throw new Error(error.message);
  const rows = data || [];
  const res: ProcessResult = { due: rows.length, completed: 0, rescheduled: 0, exhausted: 0 };
  if (rows.length === 0) return res;

  const { POST: attachPOST } = await import("@/app/api/deliverability/attach-domains-to-campaign/route");

  for (const row of rows) {
    const attempts = (row.attempts ?? 0) + 1;
    let ok = false, failed = 0, rateLimited = 0;
    try {
      const req = new Request(
        `http://internal/api/deliverability/attach-domains-to-campaign?instance=${row.instance}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ campaign_id: row.campaign_id, domains: row.domains }) },
      );
      const r = await attachPOST(req);
      const d = (await r.json().catch(() => ({}))) as { failed?: number; rateLimited?: number };
      ok = r.ok;
      failed = d.failed ?? 0;
      rateLimited = d.rateLimited ?? 0;
    } catch { ok = false; }

    // still queued/launching? → treat as not-yet-effective and go around again
    let stillDeferred = false;
    if (ok && failed === 0) {
      const { data: c } = await supabase
        .from("campaigns").select("status")
        .eq("instance", row.instance).eq("id", row.campaign_id).maybeSingle();
      stillDeferred = DEFERRED_STATUSES.has(normStatus(c?.status));
    }

    if (ok && failed === 0 && !stillDeferred) {
      await supabase.from("replacement_attach_queue")
        .update({ status: "done", attempts, updated_at: new Date().toISOString() }).eq("id", row.id);
      await logEvents([{
        instance: row.instance, clientTag: row.client_tag, eventType: "attached",
        detail: `deferred re-attach OK — "${row.campaign_name ?? row.campaign_id}" (attempt ${attempts})`,
      }]).catch(() => {});
      res.completed++;
    } else if (attempts >= MAX_ATTEMPTS) {
      await supabase.from("replacement_attach_queue")
        .update({ status: "failed", attempts, updated_at: new Date().toISOString() }).eq("id", row.id);
      // surfaces in the Retry card via the stored retry payload
      await logEvents([{
        instance: row.instance, clientTag: row.client_tag, eventType: "error",
        detail: `Deferred re-attach gave up after ${attempts} tries — "${row.campaign_name ?? row.campaign_id}" (${rateLimited ? `${rateLimited} rate-limited` : ok ? "campaign never left queue" : "attach failing"})`,
        signals: { kind: "attach_deferred_failed", retry: { step: "attach", instance: row.instance, clientTag: row.client_tag ?? "", domains: row.domains, campaignId: row.campaign_id, campaignName: row.campaign_name ?? undefined } },
      }]).catch(() => {});
      res.exhausted++;
    } else {
      await supabase.from("replacement_attach_queue")
        .update({ attempts, next_attempt_at: nextAt(), updated_at: new Date().toISOString() }).eq("id", row.id);
      res.rescheduled++;
    }
  }
  return res;
}
