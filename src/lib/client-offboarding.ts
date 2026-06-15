import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import {
  ALL_INSTANCE_SLUGS,
  instancesInGroup,
  type BisonInstanceSlug,
} from "@/lib/bison-instances";
import { getGroupForClientTag } from "@/lib/client-tag-allocations";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

export interface OffboardingResult {
  clientTag: string;
  instancesTargeted: BisonInstanceSlug[];
  pausedCampaigns: { instance: BisonInstanceSlug; id: number; name: string }[];
  pauseFailures: { instance: BisonInstanceSlug; id: number; name: string; error: string }[];
  inboxesDetagged: number;
  detagFailures: { instance: BisonInstanceSlug; inboxId: number; reason: string }[];
  affectedDomains: number;
  errors: string[];
}

function normalize(tag: string): string {
  return tag.trim().toUpperCase();
}

// Group → instance list. Unallocated tags → all 4 (per the offboarding plan).
async function resolveTargetInstances(clientTag: string): Promise<BisonInstanceSlug[]> {
  const group = await getGroupForClientTag(clientTag);
  if (group == null) return [...ALL_INSTANCE_SLUGS];
  return instancesInGroup(group).map((i) => i.slug);
}

async function findActiveCampaignsForTag(
  instance: BisonInstanceSlug,
  clientTag: string,
): Promise<SupabaseCampaignRow[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("campaigns")
    .select("id, instance, name, status")
    .eq("instance", instance)
    .eq("client_tag", clientTag)
    .not("status", "in", '("archived","paused")');
  if (error) throw new Error(`campaigns query (${instance}): ${error.message}`);
  return (data as SupabaseCampaignRow[]) ?? [];
}

async function findInboxesWithTag(
  instance: BisonInstanceSlug,
  clientTag: string,
): Promise<SupabaseInboxRow[]> {
  const supabase = getSupabaseAdmin();
  const out: SupabaseInboxRow[] = [];
  let offset = 0;
  // supabase-js's .contains() emits a PG array literal for arrays-of-objects —
  // wrong for jsonb. Pre-stringify so PostgREST routes to the jsonb `@>`
  // operator. Same pattern used in attach-nurture-inboxes/route.ts.
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

async function pauseCampaignsForInstance(
  instance: BisonInstanceSlug,
  campaigns: SupabaseCampaignRow[],
  paused: { instance: BisonInstanceSlug; id: number; name: string }[],
  failures: { instance: BisonInstanceSlug; id: number; name: string; error: string }[],
) {
  for (const c of campaigns) {
    try {
      const res = await bisonFetch(instance, `/campaigns/${c.id}/pause`, { method: "PATCH" });
      if (res.ok) {
        paused.push({ instance, id: c.id, name: c.name });
      } else {
        const text = await res.text().catch(() => "");
        failures.push({ instance, id: c.id, name: c.name, error: `${res.status}: ${text.slice(0, 200)}` });
      }
    } catch (e) {
      failures.push({
        instance, id: c.id, name: c.name,
        error: e instanceof Error ? e.message : "pause failed",
      });
    }
    await delay(200);
  }
}

async function detachTagFromInboxesForInstance(
  instance: BisonInstanceSlug,
  tagId: number,
  tagName: string,
  inboxes: SupabaseInboxRow[],
): Promise<{ detagged: number; failures: { instance: BisonInstanceSlug; inboxId: number; reason: string }[]; domainsTouched: Set<string> }> {
  const BATCH = 50;
  const supabase = getSupabaseAdmin();
  const failures: { instance: BisonInstanceSlug; inboxId: number; reason: string }[] = [];
  const successIds = new Set<number>();
  const domainsTouched = new Set<string>();

  for (let i = 0; i < inboxes.length; i += BATCH) {
    const batch = inboxes.slice(i, i + BATCH);
    const batchIds = batch.map((b) => b.id);
    try {
      const res = await bisonFetch(instance, `/tags/remove-from-sender-emails`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag_ids: [tagId], sender_email_ids: batchIds }),
      });
      if (res.ok) {
        for (const id of batchIds) successIds.add(id);
      } else if (res.status === 422) {
        // Fall back to single-id to isolate dead inboxes.
        for (const id of batchIds) {
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
        for (const id of batchIds) failures.push({ instance, inboxId: id, reason: `${res.status}: ${t.slice(0, 200)}` });
      }
    } catch (e) {
      for (const id of batchIds) {
        failures.push({ instance, inboxId: id, reason: e instanceof Error ? e.message : "request failed" });
      }
    }
    if (i + BATCH < inboxes.length) await delay(200);
  }

  // Rewrite local Supabase tags column for inboxes Bison actually accepted.
  const accepted = inboxes.filter((x) => successIds.has(x.id));
  for (const inbox of accepted) {
    domainsTouched.add(inbox.domain);
    const current = Array.isArray(inbox.tags) ? inbox.tags : [];
    const next = current.filter((t) => t.id !== tagId && t.name?.toLowerCase() !== tagName.toLowerCase());
    await supabase
      .from("deliverability_inboxes")
      .update({ tags: next })
      .eq("instance", instance)
      .eq("id", inbox.id);
  }

  return { detagged: successIds.size, failures, domainsTouched };
}

// Re-derive the domain.tags rollup from its inboxes for every (instance, domain)
// pair we touched. Mirrors the post-update step in bulk-tags/route.ts.
async function reaggregateDomainTags(
  instance: BisonInstanceSlug,
  domains: Set<string>,
) {
  const supabase = getSupabaseAdmin();
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
}

export async function previewClientOffboarding(rawTag: string): Promise<OffboardingPreview> {
  const clientTag = normalize(rawTag);
  const instances = await resolveTargetInstances(clientTag);
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

export async function executeClientOffboarding(rawTag: string): Promise<OffboardingResult> {
  const clientTag = normalize(rawTag);
  const instances = await resolveTargetInstances(clientTag);

  const pausedCampaigns: OffboardingResult["pausedCampaigns"] = [];
  const pauseFailures: OffboardingResult["pauseFailures"] = [];
  const detagFailures: OffboardingResult["detagFailures"] = [];
  const errors: string[] = [];
  let inboxesDetagged = 0;
  const affectedDomainPairs = new Set<string>();

  for (const instance of instances) {
    try {
      const camps = await findActiveCampaignsForTag(instance, clientTag);
      await pauseCampaignsForInstance(instance, camps, pausedCampaigns, pauseFailures);
    } catch (e) {
      errors.push(`[${instance}] pause-phase: ${e instanceof Error ? e.message : "failed"}`);
    }

    try {
      const inboxes = await findInboxesWithTag(instance, clientTag);
      if (inboxes.length === 0) continue;
      const tagId = await fetchTagIdByName(instance, clientTag);
      if (tagId == null) {
        // Tag doesn't exist in this instance — nothing to detach.
        continue;
      }
      const { detagged, failures, domainsTouched } = await detachTagFromInboxesForInstance(
        instance, tagId, clientTag, inboxes,
      );
      inboxesDetagged += detagged;
      detagFailures.push(...failures);
      for (const d of domainsTouched) affectedDomainPairs.add(`${instance}:${d}`);
      await reaggregateDomainTags(instance, domainsTouched);
    } catch (e) {
      errors.push(`[${instance}] detag-phase: ${e instanceof Error ? e.message : "failed"}`);
    }
  }

  return {
    clientTag,
    instancesTargeted: instances,
    pausedCampaigns,
    pauseFailures,
    inboxesDetagged,
    detagFailures,
    affectedDomains: affectedDomainPairs.size,
    errors,
  };
}
