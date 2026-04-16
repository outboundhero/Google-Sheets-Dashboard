import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

const API_BASE = "https://app.outboundhero.co/api";
const API_KEY = process.env.OUTBOUNDHERO_API_KEY!;
const apiHeaders = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Tag {
  id: number;
  name: string;
}

// GET — list all available tags from OutboundHero
export async function GET() {
  try {
    const res = await fetch(`${API_BASE}/tags`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Failed to fetch tags: ${res.status}`);
    const json = await res.json();
    const tags: Tag[] = (json.data || []).map((t: Tag) => ({
      id: t.id,
      name: t.name,
    }));
    return NextResponse.json({ tags });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST — create tag, or add/remove tags from inboxes of selected domains
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action } = body as { action: string };

    // --- CREATE TAG ---
    if (action === "create") {
      const { tagName } = body as { tagName: string };
      if (!tagName?.trim()) {
        return NextResponse.json({ error: "Tag name is required" }, { status: 400 });
      }
      const res = await fetch(`${API_BASE}/tags`, {
        method: "POST",
        headers: apiHeaders,
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

    // 1. Get all inbox IDs for the selected domains (paginate per domain to avoid 1000-row cap)
    const inboxes: { id: number; domain: string; tags: Tag[] }[] = [];
    for (const domain of domains) {
      let offset = 0;
      while (true) {
        const { data, error: inboxError } = await supabase
          .from("deliverability_inboxes")
          .select("id, domain, tags")
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
      return NextResponse.json({ success: true, inboxesAffected: 0, failed: 0, total: 0 });
    }

    const senderEmailIds = inboxes.map((i) => i.id);

    // 2. Call OutboundHero API to add or remove tags — batched with retry
    const endpoint =
      action === "add"
        ? `${API_BASE}/tags/attach-to-sender-emails`
        : `${API_BASE}/tags/remove-from-sender-emails`;

    const BATCH = 50;
    let updated = 0;
    let failed = 0;
    const successIds = new Set<number>();

    for (let i = 0; i < senderEmailIds.length; i += BATCH) {
      const batch = senderEmailIds.slice(i, i + BATCH);

      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: apiHeaders,
          body: JSON.stringify({ tag_ids: tagIds, sender_email_ids: batch }),
        });

        if (res.ok) {
          updated += batch.length;
          for (const id of batch) successIds.add(id);
        } else if (res.status === 422) {
          // Invalid IDs in batch — fall back to sub-batches of 10
          console.warn(`[BULK-TAGS] Batch ${i}-${i + batch.length} got 422, retrying in sub-batches`);
          for (let j = 0; j < batch.length; j += 10) {
            const sub = batch.slice(j, j + 10);
            try {
              const subRes = await fetch(endpoint, {
                method: "POST",
                headers: apiHeaders,
                body: JSON.stringify({ tag_ids: tagIds, sender_email_ids: sub }),
              });
              if (subRes.ok) {
                updated += sub.length;
                for (const id of sub) successIds.add(id);
              } else {
                // Try one by one to isolate bad IDs
                for (const id of sub) {
                  try {
                    const singleRes = await fetch(endpoint, {
                      method: "POST",
                      headers: apiHeaders,
                      body: JSON.stringify({ tag_ids: tagIds, sender_email_ids: [id] }),
                    });
                    if (singleRes.ok) { updated++; successIds.add(id); }
                    else { failed++; console.warn(`[BULK-TAGS] Invalid inbox ID ${id}, skipping`); }
                  } catch { failed++; }
                }
              }
            } catch { failed += sub.length; }
            await delay(200);
          }
        } else {
          const errText = await res.text().catch(() => "");
          console.error(`[BULK-TAGS] Batch ${i}-${i + batch.length}: ${res.status} ${errText.slice(0, 200)}`);
          failed += batch.length;
        }
      } catch (e) {
        console.error(`[BULK-TAGS] Batch ${i}-${i + batch.length} network error:`, e);
        failed += batch.length;
      }

      if (i + BATCH < senderEmailIds.length) await delay(300);
    }

    // 3. Fetch the tag objects for the IDs we're working with
    const tagsRes = await fetch(`${API_BASE}/tags`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      cache: "no-store",
    });
    const tagsJson = await tagsRes.json();
    const allTags: Tag[] = tagsJson.data || [];
    const tagMap = new Map(allTags.map((t) => [t.id, t]));
    const affectedTags = tagIds
      .map((id) => tagMap.get(id))
      .filter(Boolean) as Tag[];

    // 4. Update local Supabase inbox tags (only for successfully updated inboxes)
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
        .eq("id", inbox.id);
    }

    // 5. Re-aggregate domain tags from inboxes
    const affectedDomains = [...new Set(inboxes.map((i) => i.domain))];
    for (const domain of affectedDomains) {
      const { data: domainInboxes } = await supabase
        .from("deliverability_inboxes")
        .select("tags")
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
        .eq("domain", domain);
    }

    return NextResponse.json({
      success: true,
      inboxesAffected: updated,
      failed,
      total: senderEmailIds.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
