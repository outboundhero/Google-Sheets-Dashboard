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
): Promise<{ updated: number; failed: number; failedIds: number[] }> {
  const BATCH = 50;
  let updated = 0;
  let failed = 0;
  // Which inboxes did NOT take the limit — Spencer 2026-08-18 asked to retry
  // exactly those instead of re-running the whole selection.
  const failedIds: number[] = [];

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
                  else { failed++; failedIds.push(id); console.warn(`[BULK-LIMITS:${instance}] Invalid inbox ID ${id}, skipping`); }
                } catch { failed++; failedIds.push(id); }
              }
            }
          } catch { failed += sub.length; failedIds.push(...sub); }
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
    if (!success) { failed += batch.length; failedIds.push(...batch); }

    // Small delay between batches to avoid rate limiting
    if (i + BATCH < inboxIds.length) await delay(300);
  }

  return { updated, failed, failedIds };
}

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const { domains, type, limit, inboxIds: retryIds } = (await request.json()) as {
      domains?: string[];
      type: "daily" | "warmup";
      limit: number;
      // Retry path: exact inbox IDs from a previous run's `failedIds`, so a
      // retry re-hits only what failed rather than the whole selection.
      inboxIds?: { instance: string; id: number }[];
    };

    const isRetry = Array.isArray(retryIds) && retryIds.length > 0;
    if ((!domains?.length && !isRetry) || !type || limit == null) {
      return NextResponse.json({ error: "domains (or inboxIds), type, and limit required" }, { status: 400 });
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

    if (isRetry) {
      // Retry: the caller already knows the exact inboxes — no domain lookup.
      for (const row of retryIds!) {
        if (!isInstanceSlug(row.instance) || typeof row.id !== "number") continue;
        const list = byInstance.get(row.instance) ?? [];
        list.push(row.id);
        byInstance.set(row.instance, list);
      }
    } else
    for (const domain of domains!) {
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
    const failedInboxes: { instance: string; id: number }[] = [];

    // Process each instance independently.
    for (const [instance, inboxIds] of byInstance) {
      const res = await applyLimitToInboxes(instance, endpoint, inboxIds, limit);
      updated += res.updated;
      failed += res.failed;
      for (const id of res.failedIds) failedInboxes.push({ instance, id });

      // Update local Supabase data for this instance — only the inboxes that
      // actually took the change, so a failed one isn't shown as updated.
      if (res.updated > 0) {
        const failedSet = new Set(res.failedIds);
        const okIds = inboxIds.filter((id) => !failedSet.has(id));
        for (let i = 0; i < okIds.length; i += 500) {
          const batch = okIds.slice(i, i + 500);
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
      // Capped so a very large failure can't bloat the response; the count
      // above stays exact.
      failedInboxes: failedInboxes.slice(0, 5000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
