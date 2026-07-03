import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";
import { refreshProviderDomainStatus, type RefreshEntry, type UpsertRow } from "@/lib/provider-status";

// Vercel Pro cap. Batches this size fit well under it.
export const maxDuration = 300;

// Cap per invocation so we don't blow the timeout on the very first pass
// when nothing is cached yet.
const MAX_ENTRIES_PER_RUN = 5000;

interface DomainRow {
  instance: string;
  domain: string;
  tags: string[] | null;
}

interface CachedStatusRow {
  instance: string;
  domain: string;
  provider_domain_id: string | null;
  checked_at: string | null;
}

function providerFromTags(tags: string[] | null): "inboxing" | "milkbox" | null {
  if (!Array.isArray(tags)) return null;
  // Match ANY tag that STARTS WITH the provider name (case-insensitive).
  // Real tags in prod include variants like "Milkbox - Microsoft" and
  // possibly "Milkbox - Google" per user's operating pattern; anchoring on
  // the prefix catches all of them without over-matching (an "Inboxing +
  // Nurture" tag would still match Inboxing, which is what we want).
  const lower = tags.map((t) => (t || "").trim().toLowerCase()).filter(Boolean);
  if (lower.some((t) => t.startsWith("inboxing"))) return "inboxing";
  if (lower.some((t) => t.startsWith("milkbox"))) return "milkbox";
  return null;
}

export async function GET() {
  const t0 = Date.now();
  const supabase = getSupabaseAdmin();

  try {
    // 1. Load every tagged domain. deliverability_domains has ~few thousand
    //    rows total so fetching all in one shot is fine.
    const tagged: Array<{ instance: BisonInstanceSlug; domain: string; provider: "inboxing" | "milkbox" }> = [];
    {
      const PAGE = 1000;
      let offset = 0;
      while (true) {
        const { data, error } = await supabase
          .from("deliverability_domains")
          .select("instance, domain, tags")
          .range(offset, offset + PAGE - 1);
        if (error) throw new Error(`deliverability_domains read: ${error.message}`);
        if (!data || data.length === 0) break;
        for (const raw of data as DomainRow[]) {
          if (!isInstanceSlug(raw.instance)) continue;
          const provider = providerFromTags(raw.tags);
          if (!provider) continue;
          tagged.push({ instance: raw.instance, domain: raw.domain, provider });
        }
        if (data.length < PAGE) break;
        offset += PAGE;
      }
    }

    // 2. Merge in whatever provider_domain_status already knows for each
    //    (instance, domain) so we can reuse cached provider ids and pick
    //    the oldest-checked rows first.
    const cachedByKey = new Map<string, CachedStatusRow>();
    {
      const PAGE = 1000;
      let offset = 0;
      while (true) {
        const { data, error } = await supabase
          .from("provider_domain_status")
          .select("instance, domain, provider_domain_id, checked_at")
          .range(offset, offset + PAGE - 1);
        if (error) throw new Error(`provider_domain_status read: ${error.message}`);
        if (!data || data.length === 0) break;
        for (const r of data as CachedStatusRow[]) {
          cachedByKey.set(`${r.instance}:${r.domain}`, r);
        }
        if (data.length < PAGE) break;
        offset += PAGE;
      }
    }

    // 3. Build the RefreshEntry list, oldest-checked-first so if we ever
    //    hit MAX_ENTRIES_PER_RUN, we make progress on the least-fresh rows.
    const entries: RefreshEntry[] = tagged.map((t) => {
      const cached = cachedByKey.get(`${t.instance}:${t.domain}`);
      return {
        instance: t.instance,
        domain: t.domain,
        provider: t.provider,
        cached_provider_domain_id: cached?.provider_domain_id ?? null,
      };
    });
    entries.sort((a, b) => {
      // Null checked_at (never checked) sorts before any real timestamp so
      // brand-new rows get first crack at the budget.
      const av = cachedByKey.get(`${a.instance}:${a.domain}`)?.checked_at ?? "";
      const bv = cachedByKey.get(`${b.instance}:${b.domain}`)?.checked_at ?? "";
      return av.localeCompare(bv);
    });
    const batch = entries.slice(0, MAX_ENTRIES_PER_RUN);

    // 4. Refresh + upsert.
    const { ok, failed, results } = await refreshProviderDomainStatus(batch);

    if (results.length > 0) {
      // Supabase upsert in chunks of 500.
      const nowIso = new Date().toISOString();
      const rows = results.map((r: UpsertRow) => ({
        instance: r.instance,
        domain: r.domain,
        provider: r.provider,
        provider_domain_id: r.provider_domain_id,
        status: r.status,
        raw_status: r.raw_status,
        failure_reason: r.failure_reason,
        checked_at: nowIso,
      }));
      for (let i = 0; i < rows.length; i += 500) {
        const slice = rows.slice(i, i + 500);
        const { error: upErr } = await supabase
          .from("provider_domain_status")
          .upsert(slice, { onConflict: "instance,domain" });
        if (upErr) {
          console.error(`[cron/provider-domain-status] upsert failed at chunk ${i}: ${upErr.message}`);
        }
      }
    }

    // 5. Prune rows that no longer have their Inboxing/Milkbox tag (client
    //    detagged, domain got retagged as "Burnt", etc). Keeps the table
    //    tidy and prevents stale rows from lingering in the "Canceled"
    //    filter view.
    const currentKeys = new Set(tagged.map((t) => `${t.instance}:${t.domain}`));
    const stale: Array<{ instance: string; domain: string }> = [];
    for (const [key, row] of cachedByKey) {
      if (!currentKeys.has(key)) stale.push({ instance: row.instance, domain: row.domain });
    }
    let pruned = 0;
    if (stale.length > 0) {
      for (let i = 0; i < stale.length; i += 500) {
        const slice = stale.slice(i, i + 500);
        // We can't do bulk delete by tuple, so build an OR filter as a compact string.
        // For small counts (a few hundred at most in practice) this is fine.
        for (const s of slice) {
          const { error: delErr } = await supabase
            .from("provider_domain_status")
            .delete()
            .eq("instance", s.instance)
            .eq("domain", s.domain);
          if (!delErr) pruned++;
        }
      }
    }

    const durationMs = Date.now() - t0;
    const canceledCount = results.filter((r) => r.status === "canceled").length;
    console.log(
      `[cron/provider-domain-status] scanned=${tagged.length} processed=${batch.length} ok=${ok} canceled=${canceledCount} failed=${failed} pruned=${pruned} duration=${durationMs}ms`,
    );

    return NextResponse.json({
      ok: true,
      scanned: tagged.length,
      processed: batch.length,
      canceled: canceledCount,
      failed,
      pruned,
      durationMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "provider-domain-status cron failed";
    console.error("[cron/provider-domain-status]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
