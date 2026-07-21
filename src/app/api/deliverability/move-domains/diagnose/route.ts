import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import { isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";
import { findDomainByName, getDomainStatusRaw } from "@/lib/inboxing";

// GET /api/deliverability/move-domains/diagnose?domains=a.com,b.com&target=facilityreach
// (admin-only). For each domain reports where it lives in LeadSync, its Inboxing
// upload status, and how many senders Bison actually reports on the SOURCE vs
// TARGET instance — so we can tell "upload not landing" from "poll not finding".
export const maxDuration = 120;

async function countSenders(instance: BisonInstanceSlug, domain: string): Promise<number> {
  const found = new Set<number>();
  let page = 1;
  while (page <= 20) {
    const res = await bisonFetch(instance, `/sender-emails?search=${encodeURIComponent(domain)}&page=${page}&per_page=15`);
    if (!res.ok) break;
    const json = await res.json().catch(() => null);
    const payload = Array.isArray(json) ? json[0] : json;
    const data: { id: number; email: string }[] = payload?.data || [];
    for (const s of data) {
      if (s.email?.split("@")[1]?.toLowerCase() === domain.toLowerCase()) found.add(s.id);
    }
    const lastPage = payload?.meta?.last_page || 1;
    if (page >= lastPage) break;
    page++;
  }
  return found.size;
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

      // Inboxing id + upload status.
      let inboxingId = orderIdByDomain.get(domain) || null;
      let inboxing: unknown = null;
      let inboxingError: string | null = null;
      try {
        if (!inboxingId) {
          const hit = await findDomainByName(domain);
          inboxingId = hit?.id || null;
        }
        if (inboxingId) inboxing = await getDomainStatusRaw(inboxingId);
        else inboxingError = "not found on Inboxing account";
      } catch (e) {
        inboxingError = e instanceof Error ? e.message : "inboxing lookup failed";
      }

      // Live sender counts on target + source.
      let targetSenders = -1, sourceSenders = -1;
      try { targetSenders = await countSenders(target, domain); } catch { /* leave -1 */ }
      try { if (source) sourceSenders = await countSenders(source, domain); } catch { /* leave -1 */ }

      out.push({ domain, instances, inboxingId, inboxing, inboxingError, source: source ?? null, target, targetSenders, sourceSenders });
    }

    return NextResponse.json({ target, results: out });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
