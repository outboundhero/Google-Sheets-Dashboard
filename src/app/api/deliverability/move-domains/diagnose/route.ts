import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import { isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";
import { getDomainStatusRaw } from "@/lib/inboxing";

// GET /api/deliverability/move-domains/diagnose?domains=a.com,b.com&target=facilityreach
// (admin-only). For each domain reports where it lives in LeadSync, its Inboxing
// upload status, and how many senders Bison reports on the SOURCE vs TARGET
// instance — so we can tell "upload not landing" from "poll not finding".
// Fast: reads the search's meta.total in ONE call (no full paging).
export const maxDuration = 60;

async function senderSearch(instance: BisonInstanceSlug, domain: string): Promise<{ total: number; exactOnPage1: number }> {
  const res = await bisonFetch(instance, `/sender-emails?search=${encodeURIComponent(domain)}&page=1&per_page=15`);
  if (!res.ok) return { total: -1, exactOnPage1: -1 };
  const json = await res.json().catch(() => null);
  const payload = Array.isArray(json) ? json[0] : json;
  const data: { id: number; email: string }[] = payload?.data || [];
  const exact = data.filter((s) => s.email?.split("@")[1]?.toLowerCase() === domain.toLowerCase()).length;
  const total = typeof payload?.meta?.total === "number" ? payload.meta.total : data.length;
  return { total, exactOnPage1: exact };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const domains = (searchParams.get("domains") || "")
      .split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
    const target = searchParams.get("target");
    if (domains.length === 0) return NextResponse.json({ error: "domains required" }, { status: 400 });
    if (!isInstanceSlug(target)) return NextResponse.json({ error: "valid target required" }, { status: 400 });

    const supabase = getSupabaseAdmin();

    // LeadSync rows + cached Inboxing ids.
    const { data: rows } = await supabase
      .from("deliverability_domains")
      .select("instance, domain, inbox_count, tags")
      .in("domain", domains);
    const { data: orders } = await supabase
      .from("inbox_orders")
      .select("domain, provider_domain_id")
      .eq("provider", "inboxing")
      .in("domain", domains);
    const orderIdByDomain = new Map<string, string>();
    for (const o of orders || []) if (o.provider_domain_id) orderIdByDomain.set((o.domain as string).toLowerCase(), o.provider_domain_id as string);

    const out = [];
    for (const domain of domains) {
      const dRows = (rows || []).filter((r) => (r.domain as string).toLowerCase() === domain);
      const instances = dRows.map((r) => ({ instance: r.instance as string, inbox_count: (r.inbox_count as number) ?? 0, tags: (r.tags as string[]) || [] }));
      const source = instances.find((i) => i.instance !== target)?.instance as BisonInstanceSlug | undefined;

      // Inboxing upload status — only via the CACHED order id (findDomainByName
      // pages the whole account and is too slow for a live diagnostic).
      const inboxingId = orderIdByDomain.get(domain) || null;
      let inboxing: unknown = null;
      let inboxingError: string | null = null;
      if (inboxingId) {
        try { inboxing = await getDomainStatusRaw(inboxingId); }
        catch (e) { inboxingError = e instanceof Error ? e.message : "inboxing status failed"; }
      } else {
        inboxingError = "no cached Inboxing order id (resolved by name at move-time)";
      }

      // Live sender counts on target + source (search meta.total, one call each).
      const tgt = await senderSearch(target, domain).catch(() => ({ total: -1, exactOnPage1: -1 }));
      const src = source ? await senderSearch(source, domain).catch(() => ({ total: -1, exactOnPage1: -1 })) : { total: -1, exactOnPage1: -1 };

      out.push({
        domain, instances, inboxingId, inboxing, inboxingError,
        source: source ?? null, target,
        targetSenders: tgt.total, targetExactPage1: tgt.exactOnPage1,
        sourceSenders: src.total, sourceExactPage1: src.exactOnPage1,
      });
    }

    return NextResponse.json({ target, results: out });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
