import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch, resolveInstance } from "@/lib/bison";
import { isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Tag {
  id: number;
  name: string;
}

interface InboxRow {
  id: number;
  domain: string;
  email: string;
  tags: Tag[];
  instance: BisonInstanceSlug;
}

// GET — list all available tags from the selected Bison instance
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const instance = resolveInstance(searchParams.get("instance"));
    const res = await bisonFetch(instance, `/tags`);
    if (!res.ok) throw new Error(`Failed to fetch tags: ${res.status}`);
    const json = await res.json();
    const tags: Tag[] = (json.data || []).map((t: Tag) => ({
      id: t.id,
      name: t.name,
    }));
    return NextResponse.json({ tags, instance });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Fetch all tags for an instance, keyed by lowercased name for case-insensitive lookup.
async function fetchTagMap(instance: BisonInstanceSlug): Promise<Map<string, Tag>> {
  const res = await bisonFetch(instance, `/tags`);
  if (!res.ok) throw new Error(`Failed to fetch tags for ${instance}: ${res.status}`);
  const json = await res.json();
  const map = new Map<string, Tag>();
  for (const t of (json.data || []) as Tag[]) {
    if (t?.name) map.set(t.name.toLowerCase(), { id: t.id, name: t.name });
  }
  return map;
}

// Create a single tag in an instance and return it.
async function createTagInInstance(instance: BisonInstanceSlug, name: string): Promise<Tag> {
  const res = await bisonFetch(instance, `/tags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to create tag "${name}" on ${instance}: ${res.status} ${text}`);
  }
  const json = await res.json();
  const tag: Tag = json.data || json;
  return { id: tag.id, name: tag.name };
}

// Attach/remove a set of tag IDs to a set of inbox IDs within ONE instance.
// Batched (50) with 422 sub-batch + single-id fallback to isolate dead inboxes.
async function applyTagsToInboxes(
  instance: BisonInstanceSlug,
  endpoint: string,
  tagIds: number[],
  inboxIds: number[]
): Promise<{ updated: number; successIds: Set<number>; failReasons: Map<number, string> }> {
  const BATCH = 50;
  let updated = 0;
  const successIds = new Set<number>();
  const failReasons = new Map<number, string>();
  const markFailed = (ids: number[], reason: string) => {
    for (const id of ids) failReasons.set(id, reason.slice(0, 300));
  };

  for (let i = 0; i < inboxIds.length; i += BATCH) {
    const batch = inboxIds.slice(i, i + BATCH);

    try {
      const res = await bisonFetch(instance, endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag_ids: tagIds, sender_email_ids: batch }),
      });

      if (res.ok) {
        updated += batch.length;
        for (const id of batch) successIds.add(id);
      } else if (res.status === 422) {
        // Invalid IDs in batch — fall back to sub-batches of 10
        console.warn(`[BULK-TAGS:${instance}] Batch ${i}-${i + batch.length} got 422, retrying in sub-batches`);
        for (let j = 0; j < batch.length; j += 10) {
          const sub = batch.slice(j, j + 10);
          try {
            const subRes = await bisonFetch(instance, endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tag_ids: tagIds, sender_email_ids: sub }),
            });
            if (subRes.ok) {
              updated += sub.length;
              for (const id of sub) successIds.add(id);
            } else {
              // Try one by one to isolate bad IDs
              for (const id of sub) {
                try {
                  const singleRes = await bisonFetch(instance, endpoint, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ tag_ids: tagIds, sender_email_ids: [id] }),
                  });
                  if (singleRes.ok) { updated++; successIds.add(id); }
                  else {
                    const sErr = await singleRes.text().catch(() => "");
                    markFailed([id], `Bison ${singleRes.status}: ${sErr || "rejected (likely disconnected / no longer exists)"}`);
                    console.warn(`[BULK-TAGS:${instance}] Invalid inbox ID ${id}, skipping`);
                  }
                } catch (e) {
                  markFailed([id], `Network error: ${e instanceof Error ? e.message : "request failed"}`);
                }
              }
            }
          } catch (e) {
            markFailed(sub, `Network error: ${e instanceof Error ? e.message : "request failed"}`);
          }
          await delay(200);
        }
      } else {
        const errText = await res.text().catch(() => "");
        console.error(`[BULK-TAGS:${instance}] Batch ${i}-${i + batch.length}: ${res.status} ${errText.slice(0, 200)}`);
        markFailed(batch, `Bison ${res.status}: ${errText || "batch rejected"}`);
      }
    } catch (e) {
      console.error(`[BULK-TAGS:${instance}] Batch ${i}-${i + batch.length} network error:`, e);
      markFailed(batch, `Network error: ${e instanceof Error ? e.message : "request failed"}`);
    }

    if (i + BATCH < inboxIds.length) await delay(300);
  }

  return { updated, successIds, failReasons };
}

// POST — create tag, or add/remove tags from inboxes of selected domains
export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const body = await request.json();
    const { action } = body as { action: string };

    // --- CREATE TAG (explicit, single-instance) ---
    if (action === "create") {
      const instance = resolveInstance(searchParams.get("instance"));
      const { tagName } = body as { tagName: string };
      if (!tagName?.trim()) {
        return NextResponse.json({ error: "Tag name is required" }, { status: 400 });
      }
      const tag = await createTagInInstance(instance, tagName.trim());
      return NextResponse.json({ tag });
    }

    // --- ADD / REMOVE TAGS ---
    // Preferred: name-based + multi-instance. The same tag name is resolved (or
    // auto-created on "add") per instance, since Bison tag IDs are instance-scoped.
    // Legacy fallback: explicit `tagIds` against a single `?instance=`.
    const { tagIds, tagNames, domains } = body as {
      tagIds?: number[];
      tagNames?: string[];
      domains: string[];
    };

    const nameBased = Array.isArray(tagNames) && tagNames.length > 0;

    if (!domains?.length || (!nameBased && !tagIds?.length)) {
      return NextResponse.json(
        { error: "domains and (tagNames or tagIds) are required" },
        { status: 400 }
      );
    }

    const supabase = getSupabaseAdmin();

    // 1. Gather inboxes for the selected domains, grouped by instance.
    const byInstance = new Map<BisonInstanceSlug, InboxRow[]>();

    const collect = async (instanceFilter: BisonInstanceSlug | null) => {
      for (const domain of domains) {
        let offset = 0;
        while (true) {
          let q = supabase
            .from("deliverability_inboxes")
            .select("id, domain, email, tags, instance")
            .eq("domain", domain);
          if (instanceFilter) q = q.eq("instance", instanceFilter);
          const { data, error: inboxError } = await q.range(offset, offset + 999);
          if (inboxError) throw new Error(inboxError.message);
          if (!data || data.length === 0) break;
          for (const row of data as InboxRow[]) {
            const inst = row.instance;
            if (!isInstanceSlug(inst)) continue;
            const list = byInstance.get(inst) ?? [];
            list.push(row);
            byInstance.set(inst, list);
          }
          if (data.length < 1000) break;
          offset += 1000;
        }
      }
    };

    if (nameBased) {
      // All instances those domains live in.
      await collect(null);
    } else {
      const instance = resolveInstance(searchParams.get("instance"));
      await collect(instance);
    }

    const totalInboxes = [...byInstance.values()].reduce((n, list) => n + list.length, 0);
    if (totalInboxes === 0) {
      return NextResponse.json({ success: true, inboxesAffected: 0, failed: 0, total: 0, failedInboxes: [] });
    }

    const endpoint =
      action === "add"
        ? `/tags/attach-to-sender-emails`
        : `/tags/remove-from-sender-emails`;

    let totalUpdated = 0;
    // Global failure map keyed by `${instance}:${id}` (inbox IDs collide across instances).
    const failed: { email: string; domain: string; reason: string }[] = [];
    // (instance, domain) pairs we touched → re-aggregate their domain tags afterwards.
    const affectedByInstance = new Map<BisonInstanceSlug, Set<string>>();

    // 2. Process each instance independently.
    for (const [instance, inboxes] of byInstance) {
      const inboxIds = inboxes.map((i) => i.id);
      const inboxById = new Map(inboxes.map((i) => [i.id, i]));

      // Resolve the requested tags → IDs within THIS instance.
      let resolvedTags: Tag[];
      if (nameBased) {
        const tagMap = await fetchTagMap(instance);
        resolvedTags = [];
        for (const rawName of tagNames!) {
          const name = rawName.trim();
          if (!name) continue;
          const existing = tagMap.get(name.toLowerCase());
          if (existing) {
            resolvedTags.push(existing);
          } else if (action === "add") {
            // Auto-create the tag in this instance, then use it.
            try {
              const created = await createTagInInstance(instance, name);
              tagMap.set(name.toLowerCase(), created);
              resolvedTags.push(created);
            } catch (e) {
              console.error(`[BULK-TAGS:${instance}] auto-create failed:`, e);
            }
          }
          // remove + missing name → nothing to remove for this instance.
        }
      } else {
        const tagMap = await fetchTagMap(instance);
        const byId = new Map([...tagMap.values()].map((t) => [t.id, t]));
        resolvedTags = (tagIds || [])
          .map((id) => byId.get(id))
          .filter(Boolean) as Tag[];
      }

      const resolvedIds = resolvedTags.map((t) => t.id);
      if (resolvedIds.length === 0) continue;

      const { updated, successIds, failReasons } = await applyTagsToInboxes(
        instance,
        endpoint,
        resolvedIds,
        inboxIds
      );
      totalUpdated += updated;

      for (const [id, reason] of failReasons) {
        const inbox = inboxById.get(id);
        failed.push({
          email: inbox?.email || `inbox #${id}`,
          domain: inbox?.domain || "",
          reason,
        });
      }

      // 3. Update local Supabase inbox tags for successfully-updated inboxes.
      const inboxesToUpdate = inboxes.filter((i) => successIds.has(i.id));
      for (const inbox of inboxesToUpdate) {
        const currentTags: Tag[] = Array.isArray(inbox.tags) ? inbox.tags : [];
        let updatedTags: Tag[];
        if (action === "add") {
          const existingIds = new Set(currentTags.map((t) => t.id));
          updatedTags = [
            ...currentTags,
            ...resolvedTags.filter((t) => !existingIds.has(t.id)),
          ];
        } else {
          const removeIds = new Set(resolvedIds);
          updatedTags = currentTags.filter((t) => !removeIds.has(t.id));
        }
        await supabase
          .from("deliverability_inboxes")
          .update({ tags: updatedTags })
          .eq("instance", instance)
          .eq("id", inbox.id);
      }

      const domainsTouched = affectedByInstance.get(instance) ?? new Set<string>();
      for (const i of inboxes) domainsTouched.add(i.domain);
      affectedByInstance.set(instance, domainsTouched);
    }

    // 4. Re-aggregate domain tags from inboxes (per-instance, per-domain).
    for (const [instance, domainsTouched] of affectedByInstance) {
      for (const domain of domainsTouched) {
        const { data: domainInboxes } = await supabase
          .from("deliverability_inboxes")
          .select("tags")
          .eq("instance", instance)
          .eq("domain", domain);

        const tagSet = new Set<string>();
        for (const inbox of domainInboxes || []) {
          const tags: Tag[] = Array.isArray(inbox.tags) ? inbox.tags : [];
          for (const t of tags) {
            if (t.name) tagSet.add(t.name);
          }
        }

        await supabase
          .from("deliverability_domains")
          .update({ tags: Array.from(tagSet).sort() })
          .eq("instance", instance)
          .eq("domain", domain);
      }
    }

    const failedInboxes = failed.sort(
      (a, b) => a.domain.localeCompare(b.domain) || a.email.localeCompare(b.email)
    );

    return NextResponse.json({
      success: true,
      inboxesAffected: totalUpdated,
      failed: failedInboxes.length,
      total: totalInboxes,
      instances: [...byInstance.keys()],
      failedInboxes,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
