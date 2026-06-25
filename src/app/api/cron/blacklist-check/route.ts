import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { checkBlacklist } from "@/lib/blacklist-resolver";

const CONCURRENT = 100;
const TIME_BUDGET_MS = 280_000; // full daily 6am sweep
const BATCH_PULL_LIMIT = 5000;

export const maxDuration = 300;

export async function GET() {
  const t0 = Date.now();
  const supabase = getSupabaseAdmin();

  try {
    // Pull oldest-checked (or never-checked) (instance, domain) pairs first.
    // Across runs this naturally cycles through the inventory.
    const { data, error } = await supabase
      .from("deliverability_domains")
      .select("instance, domain")
      .order("blacklist_checked_at", { ascending: true, nullsFirst: true })
      .limit(BATCH_PULL_LIMIT);

    if (error) {
      console.error("[cron/blacklist-check] select failed:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const pairs = (data || [])
      .map((r) => ({
        instance: r.instance as string,
        domain: (r.domain as string)?.trim().toLowerCase(),
      }))
      .filter((p) => p.instance && p.domain);

    if (pairs.length === 0) {
      return NextResponse.json({ checked: 0, listed: 0, note: "no domains in table" });
    }

    const results: { instance: string; domain: string; blacklisted: boolean | null }[] = [];
    for (let i = 0; i < pairs.length; i += CONCURRENT) {
      if (Date.now() - t0 >= TIME_BUDGET_MS) break;
      const batch = pairs.slice(i, i + CONCURRENT);
      const settled = await Promise.allSettled(batch.map((p) => checkBlacklist(p.domain)));
      for (let j = 0; j < batch.length; j++) {
        const r = settled[j];
        results.push({
          instance: batch[j].instance,
          domain: batch[j].domain,
          blacklisted: r.status === "fulfilled" ? r.value.blacklisted : null,
        });
      }
    }

    const now = new Date().toISOString();
    // Only persist definite answers — leave inconclusive (rate-limited / errored)
    // rows untouched so they get re-tried next run.
    const upsertRows = results
      .filter((r) => r.blacklisted !== null)
      .map((r) => ({
        instance: r.instance,
        domain: r.domain,
        blacklisted: r.blacklisted as boolean,
        blacklist_checked_at: now,
      }));
    for (let i = 0; i < upsertRows.length; i += 200) {
      const { error: upsertErr } = await supabase
        .from("deliverability_domains")
        .upsert(upsertRows.slice(i, i + 200), { onConflict: "instance,domain", ignoreDuplicates: false });
      if (upsertErr) console.error("[cron/blacklist-check] upsert failed:", upsertErr.message);
    }

    const listed = results.filter((r) => r.blacklisted === true).length;
    const inconclusive = results.filter((r) => r.blacklisted === null).length;
    const durationMs = Date.now() - t0;
    console.log(
      `[cron/blacklist-check] checked=${results.length} listed=${listed} inconclusive=${inconclusive} duration=${durationMs}ms`,
    );

    return NextResponse.json({
      checked: results.length,
      listed,
      inconclusive,
      updated: upsertRows.length,
      remainingInBatch: pairs.length - results.length,
      durationMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    console.error("[cron/blacklist-check]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
