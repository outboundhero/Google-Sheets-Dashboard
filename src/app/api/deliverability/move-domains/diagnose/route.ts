import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import { isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";

// GET /api/deliverability/move-domains/diagnose?domains=a.com,b.com&target=facilityreach
// (admin-only). Reports, per domain, how many senders Bison sees on the SOURCE
// vs TARGET instance — plus how long each search took. All searches run in
// PARALLEL with a hard abort timeout so a slow/hanging Bison search can't stall
// the whole function (which is exactly what was 504'ing it).
export const maxDuration = 60;

const SEARCH_TIMEOUT_MS = 12_000;

async function senderSearch(instance: BisonInstanceSlug, domain: string): Promise<{ total: number; ms: number; note: string | null }> {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  try {
    const res = await bisonFetch(instance, `/sender-emails?search=${encodeURIComponent(domain)}&page=1&per_page=15`, { signal: ctrl.signal });
    const ms = Date.now() - t0;
    if (!res.ok) return { total: -1, ms, note: `HTTP ${res.status}` };
    const json = await res.json().catch(() => null);
    const payload = Array.isArray(json) ? json[0] : json;
    const total = typeof payload?.meta?.total === "number" ? payload.meta.total : (payload?.data?.length ?? 0);
    return { total, ms, note: null };
  } catch (e) {
    const ms = Date.now() - t0;
    const aborted = (e as Error)?.name === "AbortError";
    return { total: -1, ms, note: aborted ? `timed out after ${SEARCH_TIMEOUT_MS}ms` : (e instanceof Error ? e.message : "error") };
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const domains = (searchParams.get("domains") || "")
      .split(",").map((d) => d.trim().toLowerCase()).filter(Boolean).slice(0, 10);
    const target = searchParams.get("target");
    if (domains.length === 0) return NextResponse.json({ error: "domains required" }, { status: 400 });
    if (!isInstanceSlug(target)) return NextResponse.json({ error: "valid target required" }, { status: 400 });

    const supabase = getSupabaseAdmin();
    const { data: rows } = await supabase
      .from("deliverability_domains")
      .select("instance, domain, inbox_count")
      .in("domain", domains);

    // Run every search in parallel — 2 per domain (target + source).
    const results = await Promise.all(domains.map(async (domain) => {
      const dRows = (rows || []).filter((r) => (r.domain as string).toLowerCase() === domain);
      const instances = dRows.map((r) => ({ instance: r.instance as string, inbox_count: (r.inbox_count as number) ?? 0 }));
      const source = instances.find((i) => i.instance !== target)?.instance as BisonInstanceSlug | undefined;
      const [tgt, src] = await Promise.all([
        senderSearch(target, domain),
        source ? senderSearch(source, domain) : Promise.resolve({ total: -1, ms: 0, note: "no source row" }),
      ]);
      return {
        domain,
        instances,
        source: source ?? null,
        target,
        targetSenders: tgt.total, targetMs: tgt.ms, targetNote: tgt.note,
        sourceSenders: src.total, sourceMs: src.ms, sourceNote: src.note,
      };
    }));

    return NextResponse.json({ target, results });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
