// Bridges replacement_cancellations — the "+5 day vendor delete" intents the
// execute runner records — into the PROVEN staged wind-down machinery
// (scheduled_cancellations → fire-scheduled-cancellations cron: vendor cancel
// → 10-min buffer → Bison sender delete). Spencer signed off auto-fire on
// 2026-06-26 ("after the 5-day grace it auto-submits, no further approval"),
// but nothing ever consumed this table (gap confirmed 2026-07-30).
//
// Safety rails:
//  • rows whose scheduled_at is older than STALE_HOLD_DAYS go to 'stale-hold'
//    instead of firing — the June backlog is never mass-deleted by a deploy;
//    they're surfaced once in Slack for a human decision.
//  • a domain that carries a client tag again, or sits on the skip list, is
//    marked 'aborted' (reason appended) — never cancelled.
//  • at most MAX_PER_RUN domains bridge per invocation.
//  • the status write happens BEFORE enqueueing; if the status check
//    constraint hasn't been extended yet the whole run is a clean no-op.
import { getSupabaseAdmin } from "@/lib/supabase";
import { enqueueScheduledCancel } from "@/lib/deliverability/scheduled-cancellations";
import { postSlackMessage } from "@/lib/slack";
import { logEvents } from "./store";
import { getSkipSet, skipKey } from "./skips";
import { isInstanceSlug } from "@/lib/bison-instances";

const STALE_HOLD_DAYS = 14;
const MAX_PER_RUN = 10;

const SLACK_CHANNEL =
  process.env.SLACK_OUTBOUND_CHANNEL_ID ||
  process.env.SLACK_LEAD_SYNC_CHANNEL_ID ||
  undefined; // → postSlackMessage falls back to SLACK_TRIAGE_CHANNEL_ID

interface PendingRow {
  instance: string; domain: string; client_tag: string | null;
  reason: string | null; scheduled_at: string;
}

export interface BridgeResult {
  dryRun: boolean;
  due: number;
  bridged: string[];
  held: number;
  aborted: { domain: string; why: string }[];
  errors: string[];
}

/** Client tags currently known to the system (redirects ∪ campaign prefixes). */
async function loadKnownTags(): Promise<Set<string>> {
  const supabase = getSupabaseAdmin();
  const tags = new Set<string>();
  const [{ data: redir }, { data: camps }] = await Promise.all([
    supabase.from("client_redirects").select("client_tag"),
    supabase.from("campaigns").select("client_tag"),
  ]);
  for (const r of (redir || []) as { client_tag: string | null }[]) if (r.client_tag) tags.add(r.client_tag.toUpperCase());
  for (const c of (camps || []) as { client_tag: string | null }[]) if (c.client_tag) tags.add(c.client_tag.toUpperCase());
  return tags;
}

export async function processReplacementCancellations(
  opts: { dryRun?: boolean; limit?: number } = {},
): Promise<BridgeResult> {
  const dryRun = opts.dryRun ?? false;
  const limit = Math.max(1, Math.min(opts.limit ?? MAX_PER_RUN, 25));
  const supabase = getSupabaseAdmin();
  const res: BridgeResult = { dryRun, due: 0, bridged: [], held: 0, aborted: [], errors: [] };

  const { data, error } = await supabase
    .from("replacement_cancellations")
    .select("instance,domain,client_tag,reason,scheduled_at")
    .eq("status", "pending")
    .lte("scheduled_at", new Date().toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(500);
  if (error) { res.errors.push(error.message); return res; }
  const rows = (data || []) as PendingRow[];
  res.due = rows.length;
  if (rows.length === 0) return res;

  // Stale-hold retired (Nick 2026-08-26 "we trust the flagging now, make it
  // automatic" + Spencer 2026-09-03): overdue intents fire like fresh ones,
  // announced in a digest instead of parking for a human. 162 sat frozen for
  // days under the old behavior. Also: intents a human explicitly HELD via
  // the review card keep the 'held' status and are untouched — this only
  // changes what happens to overdue *pending* rows.
  const staleCutoff = Date.now() - STALE_HOLD_DAYS * 86_400_000;
  const stale = rows.filter((r) => new Date(r.scheduled_at).getTime() < staleCutoff);
  const fresh = rows.slice(0, limit); // age no longer disqualifies

  const setStatus = async (r: PendingRow, status: string, reasonSuffix?: string): Promise<boolean> => {
    const patch: Record<string, unknown> = { status };
    if (reasonSuffix) patch.reason = `${r.reason ?? ""}${r.reason ? " · " : ""}${reasonSuffix}`;
    const { error: uErr } = await supabase
      .from("replacement_cancellations").update(patch)
      .eq("instance", r.instance).eq("domain", r.domain).eq("status", "pending");
    if (uErr) { res.errors.push(`${r.domain}: ${uErr.message}`); return false; }
    return true;
  };

  // 1) Overdue rows just flow through the same staged cancel as fresh ones.
  //    No per-run Slack line: with a big backlog draining ~10/run the bridge
  //    re-announced the same release every pass (posted twice on 2026-09-03
  //    before the driver was stopped). The fire flow's own summaries and the
  //    per-domain history are the record.
  res.held = 0;
  if (stale.length > 0) {
    console.log(`[cancel-bridge] ${stale.length} overdue intents flowing through with this run`);
  }

  if (fresh.length === 0) return res;

  // 2) Safety checks + bridge the fresh rows into the staged cancel queue.
  const [knownTags, skipSet] = await Promise.all([loadKnownTags(), getSkipSet()]);
  for (const r of fresh) {
    if (!isInstanceSlug(r.instance)) { if (!dryRun) await setStatus(r, "aborted", "aborted: unknown instance"); res.aborted.push({ domain: r.domain, why: "unknown instance" }); continue; }

    if (skipSet.has(skipKey(r.instance, r.domain))) {
      if (!dryRun) await setStatus(r, "aborted", "aborted: on skip list");
      res.aborted.push({ domain: r.domain, why: "on skip list" });
      continue;
    }
    const { data: dRow } = await supabase
      .from("deliverability_domains").select("tags")
      .eq("instance", r.instance).eq("domain", r.domain).maybeSingle();
    const currentTag = ((dRow?.tags as string[] | null) || [])
      .map((t) => String(t).trim().toUpperCase())
      .find((t) => knownTags.has(t));
    if (currentTag) {
      if (!dryRun) await setStatus(r, "aborted", `aborted: re-assigned to ${currentTag}`);
      res.aborted.push({ domain: r.domain, why: `re-assigned to ${currentTag}` });
      continue;
    }

    if (dryRun) { res.bridged.push(r.domain); continue; }
    // mark first — if the constraint isn't extended yet nothing gets enqueued
    if (!(await setStatus(r, "bridged"))) continue;
    try {
      await enqueueScheduledCancel([r.domain], 0);   // grace already elapsed → fires on the next 15-min tick
      res.bridged.push(r.domain);
      await logEvents([{
        instance: r.instance, domain: r.domain, clientTag: r.client_tag, eventType: "cancel_queued",
        detail: "5-day grace elapsed — handed to staged vendor-cancel (cancel → 10min → Bison sender delete)",
      }]).catch(() => {});
    } catch (e) {
      res.errors.push(`${r.domain}: enqueue failed — ${e instanceof Error ? e.message : "error"}`);
    }
  }
  return res;
}
