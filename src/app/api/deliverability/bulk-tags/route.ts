import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch, resolveInstance } from "@/lib/bison";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Tag {
  id: number;
  name: string;
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

// POST — create tag, or add/remove tags from inboxes of selected domains
export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const instance = resolveInstance(searchParams.get("instance"));
    const body = await request.json();
    const { action } = body as { action: string };

    // --- CREATE TAG ---
    if (action === "create") {
      const { tagName } = body as { tagName: string };
      if (!tagName?.trim()) {
        return NextResponse.json({ error: "Tag name is required" }, { status: 400 });
      }
      const res = await bisonFetch(instance, `/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: tagName.trim() }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to create tag: ${res.status} ${text}`);
      }
      const json = await res.json();
      const tag: Tag = json.data || json;
      return NextResponse.json({ tag: { id: tag.id, name: tag.name } });
    }

    // --- ADD / REMOVE TAGS ---
    const { tagIds, domains } = body as {
      tagIds: number[];
      domains: string[];
    };

    if (!tagIds?.length || !domains?.length) {
      return NextResponse.json(
        { error: "tagIds and domains are required" },
        { status: 400 }
      );
    }

    const supabase = getSupabaseAdmin();

    // 1. Get all inbox IDs for the selected domains (scoped to this instance, paginated)
    const inboxes: { id: number; domain: string; email: string; tags: Tag[] }[] = [];
    for (const domain of domains) {
      let offset = 0;
      while (true) {
        const { data, error: inboxError } = await supabase
          .from("deliverability_inboxes")
          .select("id, domain, email, tags")
          .eq("instance", instance)
          .eq("domain", domain)
          .range(offset, offset + 999);
        if (inboxError) throw new Error(inboxError.message);
        if (!data || data.length === 0) break;
        inboxes.push(...data);
        if (data.length < 1000) break;
        offset += 1000;
      }
    }

    if (inboxes.length === 0) {
      return NextResponse.json({ success: true, inboxesAffected: 0, failed: 0, total: 0, failedInboxes: [] });
    }

    const senderEmailIds = inboxes.map((i) => i.id);
    const inboxById = new Map(inboxes.map((i) => [i.id, i]));

    // 2. Call Bison API to add or remove tags — batched with retry
    const endpoint =
      action === "add"
        ? `/tags/attach-to-sender-emails`
        : `/tags/remove-from-sender-emails`;

    const BATCH = 50;
    let updated = 0;
    const successIds = new Set<number>();
    // Map of failed inbox id → reason, so we can return the exact skipped list.
    const failReasons = new Map<number, string>();
    const markFailed = (ids: number[], reason: string) => {
      for (const id of ids) failReasons.set(id, reason.slice(0, 300));
    };

    for (let i = 0; i < senderEmailIds.length; i += BATCH) {
      const batch = senderEmailIds.slice(i, i + BATCH);

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

      if (i + BATCH < senderEmailIds.length) await delay(300);
    }

    const failed = failReasons.size;

    // 3. Fetch the tag objects for the IDs we're working with (from this instance)
    const tagsRes = await bisonFetch(instance, `/tags`);
    const tagsJson = await tagsRes.json();
    const allTags: Tag[] = tagsJson.data || [];
    const tagMap = new Map(allTags.map((t) => [t.id, t]));
    const affectedTags = tagIds
      .map((id) => tagMap.get(id))
      .filter(Boolean) as Tag[];

    // 4. Update local Supabase inbox tags (only for successfully updated inboxes, this instance)
    const inboxesToUpdate = updated > 0
      ? inboxes.filter((i) => successIds.has(i.id))
      : [];

    for (const inbox of inboxesToUpdate) {
      const currentTags: Tag[] = Array.isArray(inbox.tags) ? inbox.tags : [];
      let updatedTags: Tag[];

      if (action === "add") {
        const existingIds = new Set(currentTags.map((t) => t.id));
        updatedTags = [
          ...currentTags,
          ...affectedTags.filter((t) => !existingIds.has(t.id)),
        ];
      } else {
        const removeIds = new Set(tagIds);
        updatedTags = currentTags.filter((t) => !removeIds.has(t.id));
      }

      await supabase
        .from("deliverability_inboxes")
        .update({ tags: updatedTags })
        .eq("instance", instance)
        .eq("id", inbox.id);
    }

    // 5. Re-aggregate domain tags from inboxes (per-instance, per-domain)
    const affectedDomains = [...new Set(inboxes.map((i) => i.domain))];
    for (const domain of affectedDomains) {
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

    // Build the skipped-inbox list (email + domain + reason) for the UI.
    const failedInboxes = Array.from(failReasons.entries())
      .map(([id, reason]) => {
        const inbox = inboxById.get(id);
        return {
          email: inbox?.email || `inbox #${id}`,
          domain: inbox?.domain || "",
          reason,
        };
      })
      .sort((a, b) => a.domain.localeCompare(b.domain) || a.email.localeCompare(b.email));

    return NextResponse.json({
      success: true,
      inboxesAffected: updated,
      failed,
      total: senderEmailIds.length,
      instance,
      failedInboxes,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
