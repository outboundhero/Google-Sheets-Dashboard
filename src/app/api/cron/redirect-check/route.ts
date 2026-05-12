import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { resolveRedirect } from "@/lib/redirect-resolver";

const CONCURRENT = 20;
const TIME_BUDGET_MS = 50_000; // leave 10s for upsert + framework overhead
const BATCH_PULL_LIMIT = 500;

export const maxDuration = 60;

export async function GET() {
  const t0 = Date.now();
  const supabase = getSupabaseAdmin();

  try {
    // Pull oldest-checked (or never-checked) domains first. Across runs this
    // naturally cycles through the inventory — never-checked rows land at the
    // top via NULLS FIRST, then progressively older redirect_checked_at values.
    const { data, error } = await supabase
      .from("deliverability_domains")
      .select("domain")
      .order("redirect_checked_at", { ascending: true, nullsFirst: true })
      .limit(BATCH_PULL_LIMIT);

    if (error) {
      console.error("[cron/redirect-check] select failed:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const domains = (data || [])
      .map((r) => (r.domain as string)?.trim().toLowerCase())
      .filter(Boolean);

    if (domains.length === 0) {
      return NextResponse.json({ checked: 0, redirects: 0, note: "no domains in table" });
    }

    const results: { domain: string; redirectUrl: string | null }[] = [];
    for (let i = 0; i < domains.length; i += CONCURRENT) {
      if (Date.now() - t0 >= TIME_BUDGET_MS) break;
      const batch = domains.slice(i, i + CONCURRENT);
      const settled = await Promise.allSettled(batch.map((d) => resolveRedirect(d)));
      for (let j = 0; j < batch.length; j++) {
        const r = settled[j];
        results.push({
          domain: batch[j],
          redirectUrl: r.status === "fulfilled" ? r.value.redirectUrl : null,
        });
      }
    }

    const now = new Date().toISOString();
    const rows = results.map((r) => ({
      domain: r.domain,
      redirect_url: r.redirectUrl,
      redirect_checked_at: now,
    }));
    for (let i = 0; i < rows.length; i += 200) {
      const { error: upsertErr } = await supabase
        .from("deliverability_domains")
        .upsert(rows.slice(i, i + 200), { onConflict: "domain", ignoreDuplicates: false });
      if (upsertErr) console.error("[cron/redirect-check] upsert failed:", upsertErr.message);
    }

    const redirects = results.filter((r) => r.redirectUrl).length;
    const durationMs = Date.now() - t0;
    console.log(
      `[cron/redirect-check] checked=${results.length} redirects=${redirects} duration=${durationMs}ms`
    );

    return NextResponse.json({
      checked: results.length,
      redirects,
      remainingInBatch: domains.length - results.length,
      durationMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    console.error("[cron/redirect-check]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
