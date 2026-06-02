import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch, resolveInstance } from "@/lib/bison";
import { isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";

export const maxDuration = 300;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Apply a daily/warmup limit to a set of inbox IDs within ONE instance.
// Batched (50) with 422 sub-batch + single-id fallback to skip dead inboxes.
async function applyLimitToInboxes(
  instance: BisonInstanceSlug,
  endpoint: string,
  inboxIds: number[],
  limit: number
): Promise<{ updated: number; failed: number }> {
  const BATCH = 50;
  let updated = 0;
  let failed = 0;

  for (let i = 0; i < inboxIds.length; i += BATCH) {
    const batch = inboxIds.slice(i, i + BATCH);
    let success = false;

    try {
      const res = await bisonFetch(instance, endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender_email_ids: batch, daily_limit: limit }),
      });
      if (res.ok) {
        updated += batch.length;
        success = true;
      } else if (res.status === 422) {
        // One or more IDs are invalid — fall back to smaller sub-batches to isolate bad IDs
        console.warn(`[BULK-LIMITS:${instance}] Batch ${i}-${i + batch.length} got 422, retrying in sub-batches of 10`);
        for (let j = 0; j < batch.length; j += 10) {
          const sub = batch.slice(j, j + 10);
          try {
            const subRes = await bisonFetch(instance, endpoint, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sender_email_ids: sub, daily_limit: limit }),
            });
            if (subRes.ok) { updated += sub.length; }
            else {
              // Try one by one to skip individual bad IDs
              for (const id of sub) {
                try {
                  const singleRes = await bisonFetch(instance, endpoint, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ sender_email_ids: [id], daily_limit: limit }),
                  });
                  if (singleRes.ok) updated++;
                  else { failed++; console.warn(`[BULK-LIMITS:${instance}] Invalid inbox ID ${id}, skipping`); }
                } catch { failed++; }
              }
            }
          } catch { failed += sub.length; }
          await delay(200);
        }
        success = true; // Handled individually
      } else {
        const errText = await res.text().catch(() => "");
        console.error(`[BULK-LIMITS:${instance}] Batch ${i}-${i + batch.length}: ${res.status} ${errText.slice(0, 200)}`);
      }
    } catch (e) {
      console.error(`[BULK-LIMITS:${instance}] Batch ${i}-${i + batch.length} network error:`, e);
    }
    if (!success) failed += batch.length;

    // Small delay between batches to avoid rate limiting
    if (i + BATCH < inboxIds.length) await delay(300);
  }

  return { updated, failed };
}

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const { domains, type, limit } = (await request.json()) as {
      domains: string[];
      type: "daily" | "warmup";
      limit: number;
    };

    if (!domains?.length || !type || limit == null) {
      return NextResponse.json({ error: "domains, type, and limit required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();

    // Instance handling mirrors bulk-tags: by default operate across EVERY
    // instance the selected domains live in (so group 2 etc. work without the
    // frontend passing an instance). An explicit `?instance=` still scopes to
    // a single instance (legacy / single-instance override).
    const explicit = searchParams.get("instance");
    const instanceFilter = explicit ? resolveInstance(explicit) : null;

    // Gather inbox IDs for the selected domains, grouped by instance.
    const byInstance = new Map<BisonInstanceSlug, number[]>();
    for (const domain of domains) {
      let offset = 0;
      while (true) {
        let q = supabase
          .from("deliverability_inboxes")
          .select("id, instance")
          .eq("domain", domain);
        if (instanceFilter) q = q.eq("instance", instanceFilter);
        const { data, error } = await q.range(offset, offset + 999);
        if (error) throw new Error(error.message);
        if (!data || data.length === 0) break;
        for (const row of data as { id: number; instance: string }[]) {
          if (!isInstanceSlug(row.instance)) continue;
          const list = byInstance.get(row.instance) ?? [];
          list.push(row.id);
          byInstance.set(row.instance, list);
        }
        if (data.length < 1000) break;
        offset += 1000;
      }
    }

    const totalInboxes = [...byInstance.values()].reduce((n, l) => n + l.length, 0);
    if (totalInboxes === 0) {
      return NextResponse.json({ updated: 0, failed: 0, total: 0, type, limit, instances: [] });
    }

    const endpoint = type === "daily"
      ? `/sender-emails/daily-limits/bulk`
      : `/warmup/sender-emails/update-daily-warmup-limits`;

    const updateField = type === "daily" ? { daily_limit: limit } : { warmup_daily_limit: limit };

    let updated = 0;
    let failed = 0;

    // Process each instance independently.
    for (const [instance, inboxIds] of byInstance) {
      const res = await applyLimitToInboxes(instance, endpoint, inboxIds, limit);
      updated += res.updated;
      failed += res.failed;

      // Update local Supabase data for this instance.
      if (res.updated > 0) {
        for (let i = 0; i < inboxIds.length; i += 500) {
          const batch = inboxIds.slice(i, i + 500);
          await supabase
            .from("deliverability_inboxes")
            .update(updateField)
            .eq("instance", instance)
            .in("id", batch);
        }
      }
    }

    return NextResponse.json({
      updated,
      failed,
      total: totalInboxes,
      type,
      limit,
      instances: [...byInstance.keys()],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
