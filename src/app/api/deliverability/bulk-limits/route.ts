import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

const API_BASE = "https://app.outboundhero.co/api";
const API_KEY = process.env.OUTBOUNDHERO_API_KEY!;
const headers = { Authorization: `Bearer ${API_KEY}` };

export const maxDuration = 300;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

    // Get all inbox IDs — query each domain individually to avoid pagination issues
    const allInboxIds: number[] = [];
    for (const domain of domains) {
      let offset = 0;
      while (true) {
        const { data } = await supabase
          .from("deliverability_inboxes")
          .select("id")
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
      ? `${API_BASE}/sender-emails/daily-limits/bulk`
      : `${API_BASE}/warmup/sender-emails/update-daily-warmup-limits`;

    // Small batches (50) with retry — EmailBison may reject large batches
    const BATCH = 50;
    let updated = 0;
    let failed = 0;

    for (let i = 0; i < allInboxIds.length; i += BATCH) {
      const batch = allInboxIds.slice(i, i + BATCH);
      let success = false;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(endpoint, {
            method: "PATCH",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ sender_email_ids: batch, daily_limit: limit }),
          });
          if (res.ok) {
            updated += batch.length;
            success = true;
            break;
          }
          const errText = await res.text().catch(() => "");
          console.error(`[BULK-LIMITS] Batch ${i}-${i + batch.length} attempt ${attempt}: ${res.status} ${errText.slice(0, 200)}`);
          if (attempt < 3) await delay(2000 * attempt);
        } catch {
          if (attempt < 3) await delay(2000 * attempt);
        }
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
