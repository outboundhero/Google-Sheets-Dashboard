import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { resolveRedirect, type ResolveResult } from "@/lib/redirect-resolver";

const CONCURRENT = 20;

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

    // deliverability_domains is keyed (instance, domain) — find every
    // (instance, domain) row for the requested domain names so each one gets
    // updated (a domain name can exist on more than one Bison instance).
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
          targetRows.push({ instance: row.instance as string, domain: row.domain as string });
        }
      }
    }

    // Resolve each unique domain once.
    const resultByDomain = new Map<string, ResolveResult>();
    for (let i = 0; i < domains.length; i += CONCURRENT) {
      const batch = domains.slice(i, i + CONCURRENT);
      const settled = await Promise.allSettled(batch.map((d) => resolveRedirect(d)));
      for (let j = 0; j < batch.length; j++) {
        const r = settled[j];
        resultByDomain.set(
          batch[j],
          r.status === "fulfilled"
            ? r.value
            : { domain: batch[j], redirectUrl: null, error: "unknown" },
        );
      }
    }

    // Upsert per (instance, domain) so the existing row is actually updated.
    const now = new Date().toISOString();
    const upsertRows = targetRows.map(({ instance, domain }) => ({
      instance,
      domain,
      redirect_url: resultByDomain.get(domain)?.redirectUrl ?? null,
      redirect_checked_at: now,
    }));
    for (let i = 0; i < upsertRows.length; i += 200) {
      const { error } = await supabase
        .from("deliverability_domains")
        .upsert(upsertRows.slice(i, i + 200), { onConflict: "instance,domain", ignoreDuplicates: false });
      if (error) console.error("[check-redirects] upsert failed:", error.message);
    }

    const results = domains.map(
      (d) => resultByDomain.get(d) || { domain: d, redirectUrl: null, error: "not checked" },
    );
    return NextResponse.json({ results, checked: results.length, updated: upsertRows.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
