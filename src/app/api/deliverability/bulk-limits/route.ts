import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch, resolveInstance } from "@/lib/bison";

export const maxDuration = 300;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const instance = resolveInstance(searchParams.get("instance"));
    const { domains, type, limit } = (await request.json()) as {
      domains: string[];
      type: "daily" | "warmup";
      limit: number;
    };

    if (!domains?.length || !type || limit == null) {
      return NextResponse.json({ error: "domains, type, and limit required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();

    // Get all inbox IDs — query each domain individually (scoped to this instance)
    const allInboxIds: number[] = [];
    for (const domain of domains) {
      let offset = 0;
      while (true) {
        const { data } = await supabase
          .from("deliverability_inboxes")
          .select("id")
          .eq("instance", instance)
          .eq("domain", domain)
          .range(offset, offset + 999);
        if (!data || data.length === 0) break;
        allInboxIds.push(...data.map((d) => d.id));
        if (data.length < 1000) break;
        offset += 1000;
      }
    }

    if (allInboxIds.length === 0) {
      return NextResponse.json({ updated: 0, failed: 0, total: 0 });
    }

    const endpoint = type === "daily"
      ? `/sender-emails/daily-limits/bulk`
      : `/warmup/sender-emails/update-daily-warmup-limits`;

    // Small batches (50) with retry — EmailBison may reject large batches
    const BATCH = 50;
    let updated = 0;
    let failed = 0;

    for (let i = 0; i < allInboxIds.length; i += BATCH) {
      const batch = allInboxIds.slice(i, i + BATCH);
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
      if (i + BATCH < allInboxIds.length) await delay(300);
    }

    // Update local Supabase data
    if (updated > 0) {
      const updateField = type === "daily" ? { daily_limit: limit } : { warmup_daily_limit: limit };
      for (let i = 0; i < allInboxIds.length; i += 500) {
        const batch = allInboxIds.slice(i, i + 500);
        await supabase
          .from("deliverability_inboxes")
          .update(updateField)
          .eq("instance", instance)
          .in("id", batch);
      }
    }

    return NextResponse.json({
      updated,
      failed,
      total: allInboxIds.length,
      type,
      limit,
      instance,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
