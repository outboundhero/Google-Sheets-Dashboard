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

    const results: ResolveResult[] = [];
    for (let i = 0; i < domains.length; i += CONCURRENT) {
      const batch = domains.slice(i, i + CONCURRENT);
      const settled = await Promise.allSettled(batch.map((d) => resolveRedirect(d)));
      for (let j = 0; j < batch.length; j++) {
        const r = settled[j];
        if (r.status === "fulfilled") results.push(r.value);
        else results.push({ domain: batch[j], redirectUrl: null, error: "unknown" });
      }
    }

    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();
    const rows = results.map((r) => ({
      domain: r.domain,
      redirect_url: r.redirectUrl,
      redirect_checked_at: now,
    }));
    for (let i = 0; i < rows.length; i += 200) {
      const slice = rows.slice(i, i + 200);
      const { error } = await supabase
        .from("deliverability_domains")
        .upsert(slice, { onConflict: "domain", ignoreDuplicates: false });
      if (error) console.error("[check-redirects] upsert failed:", error.message);
    }

    return NextResponse.json({ results, checked: results.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
