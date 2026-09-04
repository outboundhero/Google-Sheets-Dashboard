// Domain reassignment workflow (Nick's 8/4 doc, item 5): move a domain from
// client A to client B with a clean 2-day wind-down so it never sends for two
// clients at once.
//
//   queued            → remove from ALL campaigns it's attached to + skip-list
//   campaigns_removed → (wait 2 days for replies/in-flight sends to stop)
//   retagged          → old tag off, new tag on (bulk-tags route, name-based)
//   attached          → attached to every non-archived campaign of the new tag,
//                       VERIFIED — a partial attach never advances (Nick:
//                       "this step can't silently partial-complete")
//   done              → redirect → new client's site, whitelist email queued,
//                       pushed to the new client's Domains sheet, skip removed
//
// No silent errors: every failure lands in attempts/last_error on the row,
// retries back off, and 6 strikes flips the row to 'failed' with a dashboard
// pipeline alert. Every step is idempotent, so a retry resumes cleanly.
//
// While a row is in flight the domain sits on the replacement skip-list with a
// loud ALL-CAPS reason, so true-up, replacement and cleanup keep their hands
// off. The skip is added at intake and removed on done/failed/cancelled.
import { getSupabaseAdmin } from "@/lib/supabase";
import { ALL_INSTANCE_SLUGS, isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";
import { addSkips, removeSkips } from "./skips";
import { logEvents } from "./store";
import { loadRedirectsByTag } from "./redirect-audit";
import { recordPipelineAlert } from "@/lib/pipeline-alerts";
import { normStatus } from "./campaigns";

const WIND_DOWN_DAYS = 2;
const MAX_ATTEMPTS = 6;
const RETRY_MIN = 30;
/** Campaign states in which Bison silently ignores account adds — retry later
 *  instead of counting a failure (same rule as the attach queue). */
const DEFERRED_STATUSES = new Set(["queued", "launching", "launch processing"]);

export type ReassignStage =
  | "queued" | "campaigns_removed" | "retagged" | "attached"
  | "done" | "failed" | "cancelled";

export interface ReassignmentRow {
  instance: string;
  domain: string;
  from_tag: string;
  to_tag: string;
  stage: ReassignStage;
  wait_until: string;
  attempts: number;
  last_error: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

const skipReason = (fromTag: string, toTag: string, until: string) =>
  `REASSIGNMENT IN PROGRESS: ${fromTag} → ${toTag} — wind-down until ${until.slice(0, 10)}, do not touch`;

/** JSON-call an imported route handler — same proven pattern as the staged
 *  cancellations worker. Throws with the route's error message on failure. */
async function callRoute(
  handler: (req: Request) => Promise<Response>,
  url: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const req = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await handler(req);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || json?.error) throw new Error(String(json?.error || `HTTP ${res.status}`));
  return json;
}

/** Which instances hold this domain (mirror). */
async function instancesOf(domain: string): Promise<BisonInstanceSlug[]> {
  const { data } = await getSupabaseAdmin()
    .from("deliverability_domains")
    .select("instance")
    .eq("domain", domain.toLowerCase());
  const out: BisonInstanceSlug[] = [];
  for (const r of data || []) if (isInstanceSlug(r.instance)) out.push(r.instance);
  return out;
}

// ── Intake ──────────────────────────────────────────────────────────────────

export interface StartResult {
  started: string[];
  rejected: { domain: string; why: string }[];
}

/** Create rows + skip entries. The heavy stage work happens in the worker —
 *  intake never does Bison calls, so a slow instance can't break submission. */
export async function startReassignments(
  domains: string[],
  fromTag: string,
  toTag: string,
): Promise<StartResult> {
  const supabase = getSupabaseAdmin();
  const res: StartResult = { started: [], rejected: [] };
  const from = fromTag.trim().toUpperCase();
  const to = toTag.trim().toUpperCase();
  if (!from || !to || from === to) throw new Error("fromTag and toTag must differ");

  // Active rows guard — one in-flight reassignment per (instance, domain).
  const { data: active } = await supabase
    .from("reassignments")
    .select("instance,domain")
    .in("stage", ["queued", "campaigns_removed", "retagged", "attached"]);
  const busy = new Set((active || []).map((r) => `${r.instance}:${r.domain}`));

  const windDownEnd = new Date(Date.now() + WIND_DOWN_DAYS * 86_400_000).toISOString();

  for (const raw of domains) {
    const domain = raw.trim().toLowerCase();
    if (!domain) continue;
    const insts = await instancesOf(domain);
    if (insts.length === 0) { res.rejected.push({ domain, why: "not found in LeadSync" }); continue; }

    // The domain must actually carry the FROM tag somewhere.
    const { data: rows } = await supabase
      .from("deliverability_domains")
      .select("instance,tags")
      .eq("domain", domain);
    const carrying = (rows || []).filter((r) =>
      ((r.tags as string[] | null) || []).some((t) => String(t).trim().toUpperCase() === from));
    if (carrying.length === 0) { res.rejected.push({ domain, why: `does not carry tag ${from}` }); continue; }

    let clash = false;
    for (const r of carrying) if (busy.has(`${r.instance}:${domain}`)) clash = true;
    if (clash) { res.rejected.push({ domain, why: "already in an active reassignment" }); continue; }

    // Skip rows only for inserts that actually landed — a half-inserted domain
    // must never sit in the machine without its do-not-touch marker.
    const inserted: { instance: string; domain: string }[] = [];
    let insertError: string | null = null;
    for (const r of carrying) {
      const { error } = await supabase.from("reassignments").insert({
        instance: r.instance,
        domain,
        from_tag: from,
        to_tag: to,
        stage: "queued",
        wait_until: new Date().toISOString(), // worker picks it up immediately
      });
      if (error) { insertError = error.message; break; }
      inserted.push({ instance: r.instance, domain });
    }
    if (inserted.length > 0) {
      await addSkips(inserted.map((e) => ({ ...e, reason: skipReason(from, to, windDownEnd) })));
    }
    if (insertError) { res.rejected.push({ domain, why: insertError }); continue; }
    res.started.push(domain);
  }

  if (res.started.length > 0) {
    await logEvents(res.started.map((domain) => ({
      domain,
      clientTag: to,
      eventType: "proposed" as const,
      detail: `reassignment started: ${from} → ${to} (campaigns off now, ${WIND_DOWN_DAYS}-day wind-down, then retag/attach/redirect/whitelist/sheet)`,
    }))).catch(() => {});
  }
  return res;
}

/** Cancel rows still in the wind-down (later stages are already B's). */
export async function cancelReassignment(instance: string, domain: string): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("reassignments")
    .update({ stage: "cancelled", updated_at: new Date().toISOString() })
    .eq("instance", instance)
    .eq("domain", domain.toLowerCase())
    .in("stage", ["queued", "campaigns_removed"])
    .select("domain");
  if (!data || data.length === 0) return false;
  await removeSkips([{ instance, domain }]);
  await logEvents([{
    domain, eventType: "skipped",
    detail: "reassignment cancelled during wind-down — domain stays with its current tag (campaigns were already removed; re-attach manually if it should keep sending)",
  }]).catch(() => {});
  return true;
}

export async function listReassignments(): Promise<ReassignmentRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("reassignments")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(300);
  if (error) throw new Error(error.message);
  return (data || []) as ReassignmentRow[];
}

// ── Worker ──────────────────────────────────────────────────────────────────

export interface WorkResult {
  processed: number;
  advanced: number;
  retried: number;
  failed: number;
  details: { domain: string; stage: string; to?: string; error?: string }[];
}

/** Keep well inside the route's 600s ceiling — a row cut off mid-flight by the
 *  platform would neither advance nor record its error. */
const RUN_BUDGET_MS = 480_000;

export async function processDueReassignments(limit = 5): Promise<WorkResult> {
  const supabase = getSupabaseAdmin();
  const res: WorkResult = { processed: 0, advanced: 0, retried: 0, failed: 0, details: [] };

  const { data, error } = await supabase
    .from("reassignments")
    .select("*")
    .in("stage", ["queued", "campaigns_removed", "retagged", "attached"])
    .lte("wait_until", new Date().toISOString())
    .order("wait_until", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  const rows = (data || []) as ReassignmentRow[];

  // Watchdog: an active row nobody has touched for 24h means something is
  // wedged (e.g. runs being cut off before they can even write an error) —
  // surface it on the dashboard. recordPipelineAlert dedupes per (source,step),
  // so repeating cron runs bump one alert instead of stacking new ones.
  try {
    const staleCut = new Date(Date.now() - 24 * 3600_000).toISOString();
    const { data: stuck } = await supabase
      .from("reassignments")
      .select("instance,domain,stage,to_tag,updated_at")
      .in("stage", ["queued", "campaigns_removed", "retagged", "attached"])
      .lt("updated_at", staleCut)
      .neq("stage", "campaigns_removed"); // the 2-day wind-down is SUPPOSED to sit still
    for (const s of stuck || []) {
      await recordPipelineAlert({
        source: "reassignment",
        step: `stuck:${s.instance}:${s.domain}`,
        clientTag: s.to_tag,
        domains: [s.domain],
        reason: `Reassignment of ${s.domain} has sat in stage "${s.stage}" for 24h+ without progress — needs a look`,
        silent: true,
      }).catch(() => {});
    }
  } catch { /* watchdog must never block the worker */ }

  const startedAt = Date.now();
  for (const row of rows) {
    if (Date.now() - startedAt > RUN_BUDGET_MS) break; // bank progress; next tick continues
    res.processed++;
    const attempts = row.attempts + 1;
    const patch = (p: Record<string, unknown>) =>
      supabase.from("reassignments")
        .update({ ...p, updated_at: new Date().toISOString() })
        .eq("instance", row.instance).eq("domain", row.domain).eq("created_at", row.created_at);

    try {
      const next = await advanceStage(row);
      await patch({ stage: next.stage, wait_until: next.waitUntil, attempts: 0, last_error: null });
      res.advanced++;
      res.details.push({ domain: row.domain, stage: row.stage, to: next.stage });
      if (next.stage === "done") {
        await removeSkips([{ instance: row.instance, domain: row.domain }]);
      }
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 400);
      if (attempts >= MAX_ATTEMPTS) {
        // The skip STAYS on a failed row — a half-moved domain (out of its
        // campaigns, tags possibly mid-change) must not be grabbed by true-up
        // or replacement until a human resolves the alert. The loud skip
        // reason marks why it's parked.
        await patch({ stage: "failed", attempts, last_error: msg });
        await recordPipelineAlert({
          source: "reassignment",
          step: `${row.stage}:${row.instance}`,
          clientTag: row.to_tag,
          domains: [row.domain],
          reason: `Reassignment ${row.from_tag} → ${row.to_tag} FAILED at stage "${row.stage}" after ${MAX_ATTEMPTS} attempts: ${msg}`,
          silent: true,
        }).catch(() => {});
        await logEvents([{
          instance: row.instance as BisonInstanceSlug, domain: row.domain, clientTag: row.to_tag,
          eventType: "error",
          detail: `reassignment failed at ${row.stage}: ${msg}`,
        }]).catch(() => {});
        res.failed++;
      } else {
        await patch({ attempts, last_error: msg, wait_until: new Date(Date.now() + RETRY_MIN * attempts * 60_000).toISOString() });
        res.retried++;
      }
      res.details.push({ domain: row.domain, stage: row.stage, error: msg });
    }
  }
  return res;
}

async function advanceStage(row: ReassignmentRow): Promise<{ stage: ReassignStage; waitUntil: string }> {
  const now = () => new Date().toISOString();
  const domain = row.domain;
  const from = row.from_tag;
  const to = row.to_tag;

  if (row.stage === "queued") {
    // Remove from EVERY campaign it's attached to (a winding-down domain must
    // not send anywhere). Discover → remove, both via the proven route.
    const { POST: removeFromCampaigns } = await import("@/app/api/deliverability/remove-from-campaigns/route");
    const url = `http://internal/api/deliverability/remove-from-campaigns?instances=${ALL_INSTANCE_SLUGS.join(",")}`;
    const disc = await callRoute(removeFromCampaigns, url, { domains: [domain], discover: true });
    const campaigns = (disc.campaigns as { id: number; instance: string; name?: string; status?: string }[] | undefined) || [];
    if (campaigns.length > 0) {
      await callRoute(removeFromCampaigns, url, { domains: [domain], campaigns });
    }
    await logEvents([{
      instance: row.instance as BisonInstanceSlug, domain, clientTag: from,
      eventType: "removed",
      detail: `reassignment: pulled from ${campaigns.length} campaign(s) [${campaigns.map((c) => c.name || c.id).join(", ").slice(0, 160)}] — ${WIND_DOWN_DAYS}-day wind-down starts`,
    }]).catch(() => {});
    return { stage: "campaigns_removed", waitUntil: new Date(Date.now() + WIND_DOWN_DAYS * 86_400_000).toISOString() };
  }

  if (row.stage === "campaigns_removed") {
    // Old tag off, new tag on — name-based, instance-aware, auto-creates the
    // new tag where missing. Also updates the mirror.
    const { POST: bulkTags } = await import("@/app/api/deliverability/bulk-tags/route");
    const url = "http://internal/api/deliverability/bulk-tags";
    await callRoute(bulkTags, url, { action: "remove", tagNames: [from], domains: [domain] });
    await callRoute(bulkTags, url, { action: "add", tagNames: [to], domains: [domain] });
    await logEvents([{
      instance: row.instance as BisonInstanceSlug, domain, clientTag: to,
      eventType: "tagged",
      detail: `reassignment: retagged ${from} → ${to} after wind-down`,
    }]).catch(() => {});
    return { stage: "retagged", waitUntil: now() };
  }

  if (row.stage === "retagged") {
    // Attach to every non-archived campaign of the NEW tag on this instance,
    // and VERIFY: any failed inbox count blocks the advance. Campaigns in
    // Bison's ignore-adds states are retried, not failed.
    const supabase = getSupabaseAdmin();
    const { data: camps } = await supabase
      .from("campaigns")
      .select("id,name,status,client_tag")
      .eq("instance", row.instance)
      .eq("client_tag", to);
    const targets = (camps || []).filter((c) => {
      const s = normStatus(c.status);
      return s !== "archived" && s !== "completed";
    });
    if (targets.length === 0) {
      throw new Error(`no campaigns found for ${to} on ${row.instance} — create them first, will retry`);
    }
    const { POST: attach } = await import("@/app/api/deliverability/attach-domains-to-campaign/route");
    const deferred: string[] = [];
    for (const c of targets) {
      if (DEFERRED_STATUSES.has(normStatus(c.status))) { deferred.push(c.name); continue; }
      const r = await callRoute(
        attach,
        `http://internal/api/deliverability/attach-domains-to-campaign?instance=${row.instance}`,
        { campaign_id: c.id, domains: [domain] },
      );
      const failed = Number(r.failed ?? 0);
      const rateLimited = Number(r.rateLimited ?? 0);
      if (failed > 0 || rateLimited > 0) {
        throw new Error(`attach to "${c.name}" incomplete (${failed} failed, ${rateLimited} rate-limited) — will retry`);
      }
    }
    if (deferred.length > 0) {
      throw new Error(`campaign(s) not accepting adds yet (${deferred.join(", ").slice(0, 120)}) — will retry`);
    }
    await logEvents([{
      instance: row.instance as BisonInstanceSlug, domain, clientTag: to,
      eventType: "attached",
      detail: `reassignment: attached to all ${targets.length} ${to} campaign(s), verified complete`,
    }]).catch(() => {});
    return { stage: "attached", waitUntil: now() };
  }

  // attached → done: redirect + whitelist + sheet. All idempotent.
  const redirects = await loadRedirectsByTag();
  const newUrl = redirects.get(to);
  if (!newUrl) {
    throw new Error(`no redirect recorded for ${to} — set the client's website first, will retry`);
  }
  const { POST: changeRedirect } = await import("@/app/api/deliverability/change-redirect/route");
  await callRoute(changeRedirect, "http://internal/api/deliverability/change-redirect", {
    dryRun: false, domains: [domain], newUrl,
  });
  const { POST: whitelistQueue } = await import("@/app/api/deliverability/whitelist/queue/route");
  await callRoute(whitelistQueue, "http://internal/api/deliverability/whitelist/queue", {
    domains: [domain], clientTag: to,
  });
  const { POST: sendToSheet } = await import("@/app/api/deliverability/send-to-sheet/route");
  await callRoute(sendToSheet, "http://internal/api/deliverability/send-to-sheet", {
    domains: [domain], clientTag: to,
  });
  await logEvents([{
    instance: row.instance as BisonInstanceSlug, domain, clientTag: to,
    eventType: "redirect_set",
    detail: `reassignment complete: redirect → ${newUrl}, whitelist queued, pushed to ${to} Domains sheet`,
  }]).catch(() => {});
  return { stage: "done", waitUntil: now() };
}
