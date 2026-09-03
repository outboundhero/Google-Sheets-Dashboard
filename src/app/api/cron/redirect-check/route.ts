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
    // Pull oldest-checked (or never-checked) (instance, domain) pairs first.
    // Across runs this naturally cycles through the inventory. Inboxing rows
    // are filtered out below (provider-redirect-sync owns their truth), and
    // when the oldest window is Inboxing-heavy a single page yields almost no
    // walkable candidates — so page deeper until we have a real batch.
    const data: { instance: string; domain: string; tags: unknown }[] = [];
    for (let off = 0; off < BATCH_PULL_LIMIT * 6; off += BATCH_PULL_LIMIT) {
      const { data: page, error } = await supabase
        .from("deliverability_domains")
        .select("instance, domain, tags")
        .order("redirect_checked_at", { ascending: true, nullsFirst: true })
        .range(off, off + BATCH_PULL_LIMIT - 1);
      if (error) {
        console.error("[cron/redirect-check] select failed:", error.message);
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      if (!page || page.length === 0) break;
      data.push(...page);
      const walkable = data.filter((r) => !(Array.isArray(r.tags) && r.tags.some((t) => String(t).trim().toLowerCase().startsWith("inboxing")))).length;
      if (walkable >= 150 || page.length < BATCH_PULL_LIMIT) break;
    }

    // Inboxing domains are masked by default — an HTTP walk sees a 200 page and
    // no redirect, so this checker recorded "none" on hundreds that were set
    // correctly. Their truth is the provider's configured redirect, written by
    // provider-redirect-sync; this cron only walks the unmasked providers.
    const isInboxing = (tags: unknown) =>
      Array.isArray(tags) && tags.some((t) => String(t).trim().toLowerCase().startsWith("inboxing"));
    const pairs = (data || [])
      .filter((r) => !isInboxing(r.tags))
      .map((r) => ({
        instance: r.instance as string,
        domain: (r.domain as string)?.trim().toLowerCase(),
      }))
      .filter((p) => p.instance && p.domain);

    if (pairs.length === 0) {
      return NextResponse.json({ checked: 0, redirects: 0, note: "no domains in table" });
    }

    const results: { instance: string; domain: string; redirectUrl: string | null }[] = [];
    for (let i = 0; i < pairs.length; i += CONCURRENT) {
      if (Date.now() - t0 >= TIME_BUDGET_MS) break;
      const batch = pairs.slice(i, i + CONCURRENT);
      const settled = await Promise.allSettled(batch.map((p) => resolveRedirect(p.domain)));
      for (let j = 0; j < batch.length; j++) {
        const r = settled[j];
        results.push({
          instance: batch[j].instance,
          domain: batch[j].domain,
          redirectUrl: r.status === "fulfilled" ? r.value.redirectUrl : null,
        });
      }
    }

    const now = new Date().toISOString();
    const rows = results.map((r) => ({
      instance: r.instance,
      domain: r.domain,
      redirect_url: r.redirectUrl,
      redirect_checked_at: now,
    }));
    for (let i = 0; i < rows.length; i += 200) {
      const { error: upsertErr } = await supabase
        .from("deliverability_domains")
        .upsert(rows.slice(i, i + 200), { onConflict: "instance,domain", ignoreDuplicates: false });
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
      remainingInBatch: pairs.length - results.length,
      durationMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    console.error("[cron/redirect-check]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
