import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

const API_BASE = "https://app.outboundhero.co/api";
const API_KEY = process.env.OUTBOUNDHERO_API_KEY!;
const headers = { Authorization: `Bearer ${API_KEY}` };

export const maxDuration = 120;

/**
 * POST /api/deliverability/bulk-limits
 * Body: { domains: string[], type: "daily" | "warmup", limit: number }
 *
 * Gets all inbox IDs for the domains, then calls the bulk update API
 * in batches of 200 to stay under payload limits.
 */
export async function POST(request: Request) {
  try {
    const { domains, type, limit } = (await request.json()) as {
      domains: string[];
      type: "daily" | "warmup";
      limit: number;
    };

    if (!domains?.length || !type || limit == null) {
      return NextResponse.json({ error: "domains, type, and limit required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();

    // Get all inbox IDs for selected domains
    const allInboxIds: number[] = [];
    for (let i = 0; i < domains.length; i += 20) {
      const batch = domains.slice(i, i + 20);
      let offset = 0;
      while (true) {
        const { data } = await supabase
          .from("deliverability_inboxes")
          .select("id")
          .in("domain", batch)
          .range(offset, offset + 999);
        if (!data || data.length === 0) break;
        allInboxIds.push(...data.map((d) => d.id));
        if (data.length < 1000) break;
        offset += 1000;
      }
    }

    if (allInboxIds.length === 0) {
      return NextResponse.json({ updated: 0, total: 0 });
    }

    // Bulk update in batches of 200
    const BATCH = 200;
    let updated = 0;
    let failed = 0;
    const endpoint = type === "daily"
      ? `${API_BASE}/sender-emails/daily-limits/bulk`
      : `${API_BASE}/warmup/sender-emails/update-daily-warmup-limits`;

    for (let i = 0; i < allInboxIds.length; i += BATCH) {
      const batch = allInboxIds.slice(i, i + BATCH);
      try {
        const res = await fetch(endpoint, {
          method: "PATCH",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ sender_email_ids: batch, daily_limit: limit }),
        });
        if (res.ok) {
          updated += batch.length;
        } else {
          failed += batch.length;
        }
      } catch {
        failed += batch.length;
      }
    }

    // Update local Supabase data
    if (updated > 0) {
      const updateField = type === "daily" ? { daily_limit: limit } : { warmup_daily_limit: limit };
      // Update in batches (Supabase .in() has limits)
      for (let i = 0; i < allInboxIds.length; i += 500) {
        const batch = allInboxIds.slice(i, i + 500);
        await supabase
          .from("deliverability_inboxes")
          .update(updateField)
          .in("id", batch);
      }
    }

    return NextResponse.json({
      updated,
      failed,
      total: allInboxIds.length,
      type,
      limit,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
