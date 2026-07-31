import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import {
  ALL_INSTANCE_SLUGS,
  isInstanceSlug,
  type BisonInstanceSlug,
} from "@/lib/bison-instances";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DETAG_BATCH = 50;

interface SupabaseCampaignRow {
  id: number;
  instance: BisonInstanceSlug;
  name: string;
  status: string;
}

interface SupabaseInboxRow {
  id: number;
  domain: string;
  email: string;
  tags: { id: number; name: string }[] | null;
}

interface BisonTag {
  id: number;
  name: string;
}

export interface OffboardingPreview {
  clientTag: string;
  instancesTargeted: BisonInstanceSlug[];
  activeCampaigns: number;
  inboxesWithTag: number;
  affectedDomains: number;
}

// Step types — emitted by planClientOffboarding, consumed by executePlanStep.
export type PlanStep =
  | { id: string; kind: "pause-campaign"; instance: BisonInstanceSlug; label: string; campaignId: number; campaignName: string; campaignStatus?: string }
  | { id: string; kind: "detag-inbox-batch"; instance: BisonInstanceSlug; label: string; tagId: number; tagName: string; inboxIds: number[]; domains: string[] }
  | { id: string; kind: "reaggregate-domains"; instance: BisonInstanceSlug; label: string; domains: string[] };

export interface OffboardingPlan {
  clientTag: string;
  instancesTargeted: BisonInstanceSlug[];
  summary: {
    campaigns: number;
    inboxes: number;
    domains: number;
  };
  perInstance: {
    instance: BisonInstanceSlug;
    campaigns: number;
    inboxes: number;
    tagId: number | null;       // null if the tag doesn't exist in this instance
  }[];
  steps: PlanStep[];
}

export interface StepResult {
  ok: boolean;
  error: string | null;
  // "skipped" means there was no real work to do (e.g. campaign already gone
  // from Bison). Distinct from a failure so the UI can tally it separately.
  skipped?: { reason: string };
  // Optional rolled-up counts so the frontend tally is accurate.
  pausedCampaign?: { instance: BisonInstanceSlug; id: number; name: string };
  archiveNote?: string;   // set when pause succeeded but the archive step didn't
  detagged?: number;
  detagFailures?: { instance: BisonInstanceSlug; inboxId: number; reason: string }[];
}

// Returned by executeClientOffboarding (cron path). Same shape the FE builds
// by aggregating per-step results.
export interface OffboardingResult {
  clientTag: string;
  instancesTargeted: BisonInstanceSlug[];
  pausedCampaigns: { instance: BisonInstanceSlug; id: number; name: string }[];
  // Campaigns we couldn't pause because they don't exist in Bison anymore —
  // stale Supabase rows that the cron hasn't pruned. Not a real failure.
  pauseSkipped: { instance: BisonInstanceSlug; id: number; name: string; reason: string }[];
  pauseFailures: { instance: BisonInstanceSlug; id: number; name: string; error: string }[];
  inboxesDetagged: number;
  detagFailures: { instance: BisonInstanceSlug; inboxId: number; reason: string }[];
  affectedDomains: number;
  errors: string[];
}

function normalize(tag: string): string {
  return tag.trim().toUpperCase();
}

// Offboarding ALWAYS scans all 4 instances — never group-scoped. Clients can
// move between groups, and stale campaigns / tagged inboxes can linger in the
// other group's instances after a move; scanning everything guarantees they're
// caught. An instance where this client has nothing is a cheap no-op.
function resolveTargetInstances(): BisonInstanceSlug[] {
  return [...ALL_INSTANCE_SLUGS];
}

// Bison campaign statuses that are ACTIVELY sending or about to send — the
// ones offboarding needs to pause. Draft/Paused/Completed/Archived are all
// no-ops for the outbound pipeline and were previously being counted as
// "active" here because the old blocklist was:
//   .not("status", "in", '("archived","paused")')
// That query was also case-sensitive at the Postgres layer, so any status
// stored TitleCase (Bison returns TitleCase from some endpoints, lowercase
// from others) slipped through the filter. YBS with 2 Draft campaigns and 0
// Active ones showed "2 active campaigns to pause" for exactly this reason.
//
// Fix: fetch by (instance, client_tag) then filter case-insensitively in JS
// against an explicit allowlist of live statuses. Matches how Bison labels
// campaigns as "Active" in the UI.
// Statuses that still need pausing (actively sending / about to). Everything
// else that isn't already archived/completed just needs archiving directly.
const ACTIVE_CAMPAIGN_STATUSES = new Set(["active", "launching", "queued", "launch processing"]);
// Churned clients: ARCHIVE every campaign that isn't already gone (Spencer's
// Loom: "these aren't current clients — archive the campaign, no harm"). So we
// act on everything EXCEPT already-archived/completed — including draft + paused
// ones the old flow left sitting on the client (SQFT's 13 draft + 11 paused).
const ALREADY_DONE_STATUSES = new Set(["archived", "completed"]);

async function findActiveCampaignsForTag(
  instance: BisonInstanceSlug,
  clientTag: string,
): Promise<SupabaseCampaignRow[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("campaigns")
    .select("id, instance, name, status")
    .eq("instance", instance)
    .eq("client_tag", clientTag);
  if (error) throw new Error(`campaigns query (${instance}): ${error.message}`);
  const rows = (data as SupabaseCampaignRow[]) ?? [];
  return rows.filter((c) => !ALREADY_DONE_STATUSES.has((c.status || "").trim().toLowerCase()));
}

async function findInboxesWithTag(
  instance: BisonInstanceSlug,
  clientTag: string,
): Promise<SupabaseInboxRow[]> {
  const supabase = getSupabaseAdmin();
  const out: SupabaseInboxRow[] = [];
  let offset = 0;
  const needle = JSON.stringify([{ name: clientTag }]);
  while (true) {
    const { data, error } = await supabase
      .from("deliverability_inboxes")
      .select("id, domain, email, tags")
      .eq("instance", instance)
      .filter("tags", "cs", needle)
      .range(offset, offset + 999);
    if (error) throw new Error(`inboxes query (${instance}): ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...(data as SupabaseInboxRow[]));
    if (data.length < 1000) break;
    offset += 1000;
  }
  return out;
}

async function fetchTagIdByName(
  instance: BisonInstanceSlug,
  tagName: string,
): Promise<number | null> {
  const res = await bisonFetch(instance, `/tags`);
  if (!res.ok) throw new Error(`fetch tags (${instance}): ${res.status}`);
  const json = await res.json();
  const wanted = tagName.toLowerCase();
  for (const t of (json.data || []) as BisonTag[]) {
    if (t?.name?.toLowerCase() === wanted) return t.id;
  }
  return null;
}

// ===== preview (cheap counts) =====

export async function previewClientOffboarding(rawTag: string): Promise<OffboardingPreview> {
  const clientTag = normalize(rawTag);
  const instances = resolveTargetInstances();
  let activeCampaigns = 0;
  let inboxesWithTag = 0;
  const allDomains = new Set<string>();
  for (const instance of instances) {
    const camps = await findActiveCampaignsForTag(instance, clientTag);
    activeCampaigns += camps.length;
    const inboxes = await findInboxesWithTag(instance, clientTag);
    inboxesWithTag += inboxes.length;
    for (const i of inboxes) allDomains.add(`${instance}:${i.domain}`);
  }
  return {
    clientTag,
    instancesTargeted: instances,
    activeCampaigns,
    inboxesWithTag,
    affectedDomains: allDomains.size,
  };
}

// Domains whose LOCAL rollup still lists the tag (bare-prefix match — same
// rule as the churned-card Done check). These linger when the tag sits only at
// the domain level (its inboxes already clean or gone), because nothing
// refreshes that rollup until the next deliverability sync.
async function findDomainsStillShowingTag(
  instance: BisonInstanceSlug,
  clientTag: string,
): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const bare = normalize(clientTag).split(":")[0].trim();
  const out: string[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("deliverability_domains")
      .select("domain,tags")
      .eq("instance", instance)
      .range(offset, offset + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const d of data) {
      const tags = Array.isArray(d.tags) ? (d.tags as string[]) : [];
      if (tags.some((t) => String(t).split(":")[0].trim().toUpperCase() === bare)) {
        out.push(d.domain as string);
      }
    }
    if (data.length < 1000) break;
    offset += 1000;
  }
  return out;
}

// ===== plan (full ordered step list for FE-driven execution) =====

export async function planClientOffboarding(rawTag: string): Promise<OffboardingPlan> {
  const clientTag = normalize(rawTag);
  const instances = resolveTargetInstances();
  const steps: PlanStep[] = [];
  const perInstance: OffboardingPlan["perInstance"] = [];
  let stepCounter = 0;
  const nextId = () => `s${++stepCounter}`;
  let totalCampaigns = 0;
  let totalInboxes = 0;
  const allDomainPairs = new Set<string>();

  for (const instance of instances) {
    const camps = await findActiveCampaignsForTag(instance, clientTag);
    const inboxes = await findInboxesWithTag(instance, clientTag);
    // Tag id is needed for detag steps. Skip detag entirely if the tag doesn't
    // exist in this instance (nothing to detach).
    const tagId = inboxes.length > 0 ? await fetchTagIdByName(instance, clientTag) : null;

    perInstance.push({
      instance,
      campaigns: camps.length,
      inboxes: inboxes.length,
      tagId,
    });
    totalCampaigns += camps.length;
    totalInboxes += inboxes.length;

    for (const c of camps) {
      steps.push({
        id: nextId(),
        kind: "pause-campaign",
        instance,
        label: `Pause + archive "${c.name}" (${instance})`,
        campaignId: c.id,
        campaignName: c.name,
        campaignStatus: c.status,
      });
    }

    const coveredDomains = new Set<string>();
    if (inboxes.length > 0 && tagId != null) {
      const domains = new Set<string>();
      for (const ib of inboxes) {
        domains.add(ib.domain);
        allDomainPairs.add(`${instance}:${ib.domain}`);
        coveredDomains.add(ib.domain);
      }
      const domainList = Array.from(domains).sort();

      for (let i = 0; i < inboxes.length; i += DETAG_BATCH) {
        const slice = inboxes.slice(i, i + DETAG_BATCH);
        const batchNo = Math.floor(i / DETAG_BATCH) + 1;
        const totalBatches = Math.ceil(inboxes.length / DETAG_BATCH);
        steps.push({
          id: nextId(),
          kind: "detag-inbox-batch",
          instance,
          label: `Detag ${slice.length} inboxes (batch ${batchNo}/${totalBatches}, ${instance})`,
          tagId,
          tagName: clientTag,
          inboxIds: slice.map((s) => s.id),
          // domain list is per-batch (subset) so the FE can show per-batch context
          domains: Array.from(new Set(slice.map((s) => s.domain))).sort(),
        });
      }

      steps.push({
        id: nextId(),
        kind: "reaggregate-domains",
        instance,
        label: `Refresh domain rollups (${instance}, ${domainList.length} domains)`,
        domains: domainList,
      });
    }

    // Sweep: rollups that still show the tag beyond the domains handled above
    // (tag lingering only at the domain level, inboxes already clean or gone).
    // Those never refreshed until the next deliverability sync, which left the
    // churned card sitting on "Offboard" long after a finished offboarding.
    // Reaggregating from inbox truth flips "Done" immediately and stays
    // honest — an inbox that really still carries the tag keeps its rollup.
    const lingering = (await findDomainsStillShowingTag(instance, clientTag))
      .filter((d) => !coveredDomains.has(d));
    if (lingering.length > 0) {
      steps.push({
        id: nextId(),
        kind: "reaggregate-domains",
        instance,
        label: `Refresh ${lingering.length} lingering domain rollup(s) (${instance})`,
        domains: lingering,
      });
    }
  }

  return {
    clientTag,
    instancesTargeted: instances,
    summary: {
      campaigns: totalCampaigns,
      inboxes: totalInboxes,
      domains: allDomainPairs.size,
    },
    perInstance,
    steps,
  };
}

// ===== single-step execution =====

async function pauseCampaignStep(
  instance: BisonInstanceSlug,
  campaignId: number,
  campaignName: string,
  campaignStatus?: string,
): Promise<StepResult> {
  // A draft/paused campaign isn't sending — if we can't archive it, that's a
  // harmless SKIP, not a failure to retry forever. Only a genuinely-active
  // campaign we can't stop is a real failure.
  const wasActive = ACTIVE_CAMPAIGN_STATUSES.has((campaignStatus || "active").trim().toLowerCase());
  try {
    // Churned clients' campaigns should end up ARCHIVED (Spencer's Loom: "no
    // harm archiving — these aren't current clients"). Pause is best-effort
    // (only active campaigns can pause; draft/paused ones can't and don't need
    // to) — ARCHIVE is the real goal and we do it regardless.
    const pauseRes = await bisonFetch(instance, `/campaigns/${campaignId}/pause`, { method: "PATCH" });
    // 404 on pause = campaign gone from Bison → prune the stale local row.
    if (pauseRes.status === 404) {
      await getSupabaseAdmin().from("campaigns").delete().eq("instance", instance).eq("id", campaignId);
      return { ok: false, error: null, skipped: { reason: "no longer in Bison (stale row)" } };
    }
    const paused = pauseRes.ok; // draft/already-paused → not ok, that's fine

    // Archive — the outcome we actually want.
    const arch = await bisonFetch(instance, `/campaigns/${campaignId}/archive`, { method: "PATCH" });
    if (arch.status === 404) {
      await getSupabaseAdmin().from("campaigns").delete().eq("instance", instance).eq("id", campaignId);
      return { ok: false, error: null, skipped: { reason: "no longer in Bison (stale row)" } };
    }
    const archived = arch.ok;

    // Update our local row NOW — the campaigns cron only syncs daily, and the
    // stale status is why offboard previews kept re-listing already-handled
    // campaigns (Spencer's JPR/SQFT loop).
    const finalStatus = archived ? "Archived" : paused ? "Paused" : null;
    if (finalStatus) {
      await getSupabaseAdmin().from("campaigns").update({ status: finalStatus }).eq("instance", instance).eq("id", campaignId);
    }

    if (archived) {
      return { ok: true, error: null, pausedCampaign: { instance, id: campaignId, name: campaignName } };
    }
    if (paused) {
      // paused but archive failed → safe (not sending), surfaced as a soft note
      const t = await arch.text().catch(() => "");
      return { ok: true, error: null, pausedCampaign: { instance, id: campaignId, name: campaignName }, archiveNote: `paused OK but archive failed (Bison ${arch.status}: ${t.slice(0, 120)}) — still paused` };
    }
    // neither pause nor archive worked. If it was active (still sending) that's
    // a real failure; if it was draft/paused it's a harmless skip.
    const pt = await pauseRes.text().catch(() => "");
    if (wasActive) return { ok: false, error: `pause+archive failed (pause ${pauseRes.status}: ${pt.slice(0, 120)})` };
    return { ok: false, error: null, skipped: { reason: `${campaignStatus || "non-active"} campaign — couldn't archive (not sending, left as-is)` } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "pause/archive failed" };
  }
}

async function detagInboxBatchStep(
  instance: BisonInstanceSlug,
  tagId: number,
  tagName: string,
  inboxIds: number[],
): Promise<StepResult> {
  const supabase = getSupabaseAdmin();
  const successIds = new Set<number>();
  const failures: { instance: BisonInstanceSlug; inboxId: number; reason: string }[] = [];

  try {
    const res = await bisonFetch(instance, `/tags/remove-from-sender-emails`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag_ids: [tagId], sender_email_ids: inboxIds }),
    });
    if (res.ok) {
      for (const id of inboxIds) successIds.add(id);
    } else if (res.status === 422) {
      // Single-id fallback to isolate dead inboxes.
      for (const id of inboxIds) {
        try {
          const sr = await bisonFetch(instance, `/tags/remove-from-sender-emails`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tag_ids: [tagId], sender_email_ids: [id] }),
          });
          if (sr.ok) successIds.add(id);
          else {
            const t = await sr.text().catch(() => "");
            failures.push({ instance, inboxId: id, reason: `${sr.status}: ${t.slice(0, 200)}` });
          }
        } catch (e) {
          failures.push({ instance, inboxId: id, reason: e instanceof Error ? e.message : "request failed" });
        }
      }
    } else {
      const t = await res.text().catch(() => "");
      const msg = `Bison ${res.status}: ${t.slice(0, 200)}`;
      for (const id of inboxIds) failures.push({ instance, inboxId: id, reason: msg });
      return { ok: false, error: msg, detagged: 0, detagFailures: failures };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "request failed";
    for (const id of inboxIds) failures.push({ instance, inboxId: id, reason: msg });
    return { ok: false, error: msg, detagged: 0, detagFailures: failures };
  }

  if (successIds.size === 0) {
    return { ok: false, error: failures[0]?.reason || "no inboxes detagged", detagged: 0, detagFailures: failures };
  }

  // Strip the tag from each accepted inbox's local Supabase row.
  const { data: existing, error: selErr } = await supabase
    .from("deliverability_inboxes")
    .select("id, tags")
    .eq("instance", instance)
    .in("id", Array.from(successIds));
  if (selErr) {
    return { ok: false, error: `local select: ${selErr.message}`, detagged: 0, detagFailures: failures };
  }
  for (const row of existing || []) {
    const current = Array.isArray(row.tags) ? (row.tags as BisonTag[]) : [];
    const next = current.filter(
      (t) => t.id !== tagId && t.name?.toLowerCase() !== tagName.toLowerCase(),
    );
    await supabase
      .from("deliverability_inboxes")
      .update({ tags: next })
      .eq("instance", instance)
      .eq("id", row.id);
  }

  return {
    ok: failures.length === 0,
    error: failures.length > 0 ? failures[0].reason : null,
    detagged: successIds.size,
    detagFailures: failures,
  };
}

async function reaggregateDomainsStep(
  instance: BisonInstanceSlug,
  domains: string[],
): Promise<StepResult> {
  const supabase = getSupabaseAdmin();
  try {
    for (const domain of domains) {
      const { data } = await supabase
        .from("deliverability_inboxes")
        .select("tags")
        .eq("instance", instance)
        .eq("domain", domain);
      const tagSet = new Set<string>();
      for (const inbox of data || []) {
        const tags = Array.isArray(inbox.tags) ? (inbox.tags as BisonTag[]) : [];
        for (const t of tags) if (t.name) tagSet.add(t.name);
      }
      await supabase
        .from("deliverability_domains")
        .update({ tags: Array.from(tagSet).sort() })
        .eq("instance", instance)
        .eq("domain", domain);
    }
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "reaggregate failed" };
  }
}

export async function executePlanStep(step: PlanStep): Promise<StepResult> {
  if (!isInstanceSlug(step.instance)) {
    return { ok: false, error: `unknown instance: ${step.instance}` };
  }
  switch (step.kind) {
    case "pause-campaign":
      return pauseCampaignStep(step.instance, step.campaignId, step.campaignName, step.campaignStatus);
    case "detag-inbox-batch":
      return detagInboxBatchStep(step.instance, step.tagId, step.tagName, step.inboxIds);
    case "reaggregate-domains":
      return reaggregateDomainsStep(step.instance, step.domains);
    default: {
      const _exhaustive: never = step;
      void _exhaustive;
      return { ok: false, error: "unknown step kind" };
    }
  }
}

// ===== synchronous executor (cron path) — walks its own plan =====

export async function executeClientOffboarding(rawTag: string): Promise<OffboardingResult> {
  const clientTag = normalize(rawTag);
  const plan = await planClientOffboarding(clientTag);
  const pausedCampaigns: OffboardingResult["pausedCampaigns"] = [];
  const pauseSkipped: OffboardingResult["pauseSkipped"] = [];
  const pauseFailures: OffboardingResult["pauseFailures"] = [];
  const detagFailures: OffboardingResult["detagFailures"] = [];
  const errors: string[] = [];
  let inboxesDetagged = 0;
  const affectedDomainPairs = new Set<string>();

  for (const step of plan.steps) {
    const result = await executePlanStep(step);
    if (step.kind === "pause-campaign") {
      if (result.ok && result.pausedCampaign) {
        pausedCampaigns.push(result.pausedCampaign);
      } else if (result.skipped) {
        pauseSkipped.push({
          instance: step.instance,
          id: step.campaignId,
          name: step.campaignName,
          reason: result.skipped.reason,
        });
      } else if (result.error) {
        pauseFailures.push({
          instance: step.instance,
          id: step.campaignId,
          name: step.campaignName,
          error: result.error,
        });
      }
    } else if (step.kind === "detag-inbox-batch") {
      if (result.detagged) inboxesDetagged += result.detagged;
      if (result.detagFailures) detagFailures.push(...result.detagFailures);
      for (const d of step.domains) affectedDomainPairs.add(`${step.instance}:${d}`);
      if (!result.ok && result.error) errors.push(`[${step.instance}] detag: ${result.error}`);
    } else if (step.kind === "reaggregate-domains") {
      if (!result.ok && result.error) errors.push(`[${step.instance}] reaggregate: ${result.error}`);
    }
    await delay(150);
  }

  return {
    clientTag,
    instancesTargeted: plan.instancesTargeted,
    pausedCampaigns,
    pauseSkipped,
    pauseFailures,
    inboxesDetagged,
    detagFailures,
    affectedDomains: affectedDomainPairs.size,
    errors,
  };
}
