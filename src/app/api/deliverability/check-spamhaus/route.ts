import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  checkSpamhausDbl,
  type SpamhausResult,
} from "@/lib/spamhaus-dbl-resolver";

const CONCURRENT = 100;

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const raw = Array.isArray(body?.domains) ? body.domains : [];
    const normalized: string[] = [];
    for (const d of raw) {
      if (typeof d !== "string") continue;
      const v = d.trim().toLowerCase();
      if (v) normalized.push(v);
    }
    const domains: string[] = Array.from(new Set<string>(normalized));
    if (domains.length === 0) {
      return NextResponse.json({ error: "domains array required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();

    // Find every (instance, domain) row for the requested names so the same
    // domain in multiple instances gets each of its rows updated.
    const targetRows: { instance: string; domain: string }[] = [];
    for (let i = 0; i < domains.length; i += 200) {
      const slice = domains.slice(i, i + 200);
      const { data, error } = await supabase
        .from("deliverability_domains")
        .select("instance, domain")
        .in("domain", slice);
      if (error) throw new Error(error.message);
      for (const row of data || []) {
        if (row.instance && row.domain) {
          targetRows.push({
            instance: row.instance as string,
            domain: row.domain as string,
          });
        }
      }
    }

    const resultByDomain = new Map<string, SpamhausResult>();
    for (let i = 0; i < domains.length; i += CONCURRENT) {
      const batch = domains.slice(i, i + CONCURRENT);
      const settled = await Promise.allSettled(batch.map((d) => checkSpamhausDbl(d)));
      for (let j = 0; j < batch.length; j++) {
        const r = settled[j];
        resultByDomain.set(
          batch[j],
          r.status === "fulfilled"
            ? r.value
            : { domain: batch[j], blacklisted: null, category: null, error: "unknown" },
        );
      }
    }

    // Only write rows we got a definite answer for. Inconclusive (denied / DNS
    // error) results leave the existing value alone so the next run retries.
    const now = new Date().toISOString();
    const upsertRows = targetRows
      .map(({ instance, domain }) => {
        const r = resultByDomain.get(domain);
        if (!r || r.blacklisted === null) return null;
        return {
          instance,
          domain,
          spamhaus_dbl: r.blacklisted,
          spamhaus_checked_at: now,
        };
      })
      .filter(
        (r): r is { instance: string; domain: string; spamhaus_dbl: boolean; spamhaus_checked_at: string } =>
          r !== null,
      );

    for (let i = 0; i < upsertRows.length; i += 200) {
      const { error } = await supabase
        .from("deliverability_domains")
        .upsert(upsertRows.slice(i, i + 200), { onConflict: "instance,domain", ignoreDuplicates: false });
      if (error) console.error("[check-spamhaus] upsert failed:", error.message);
    }

    const results = domains.map(
      (d) => resultByDomain.get(d) || { domain: d, blacklisted: null, category: null, error: "not checked" },
    );
    const listed = results.filter((r) => r.blacklisted === true).length;
    const inconclusive = results.filter((r) => r.blacklisted === null).length;
    return NextResponse.json({
      results,
      checked: results.length,
      listed,
      inconclusive,
      updated: upsertRows.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
