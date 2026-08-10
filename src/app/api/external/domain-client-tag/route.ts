import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getAllClientTags } from "@/lib/google-sheets";

// GET /api/external/domain-client-tag?domain=<domain>
// Token-auth (Bearer EXTERNAL_API_TOKEN), middleware-exempt like the other
// /api/external/* routes. Given a sending domain, returns the client tag(s)
// it's associated with — read from the LeadSync deliverability rollup
// (deliverability_domains.tags, unioned across all 4 Bison instances) and
// filtered to tags that are recognized client tags in the Client Tracker.
//
// Response: { domain, clientTag, clientTags, instances, allTags, found }
//   clientTag  = primary recognized client tag (first match) or null
//   clientTags = every recognized client tag on the domain (usually one)
//   instances  = which Bison instances carry the domain
//   allTags    = every raw tag on the domain (debugging aid)
//   found      = whether the domain exists in the deliverability data

const EXTERNAL_API_TOKEN = process.env.EXTERNAL_API_TOKEN || "outboundhero2024";

/** Normalize a domain: strip scheme / path / leading www, lowercase. */
function normalizeDomain(raw: string): string {
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "");
  d = d.split("/")[0].split("?")[0];
  d = d.replace(/^www\./, "");
  return d.trim();
}

/** Bare client-tag form for matching: drop a trailing ": Leads", uppercase. */
function bareTag(name: string): string {
  return name.replace(/:\s*leads\s*$/i, "").trim().toUpperCase();
}

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader || authHeader !== `Bearer ${EXTERNAL_API_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const url = new URL(request.url);
    const domain = normalizeDomain(url.searchParams.get("domain") || "");
    if (!domain) {
      return NextResponse.json({ error: "domain query parameter is required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("deliverability_domains")
      .select("instance, domain, tags")
      .eq("domain", domain);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const rows = data || [];
    const found = rows.length > 0;

    // Union raw tags + instances across every (instance, domain) row.
    const allTags = new Set<string>();
    const instances = new Set<string>();
    for (const r of rows) {
      if (r.instance) instances.add(r.instance as string);
      const tags = Array.isArray(r.tags) ? (r.tags as string[]) : [];
      for (const t of tags) if (typeof t === "string" && t.trim()) allTags.add(t.trim());
    }

    // Canonical client tags → UPPERCASE-bare → original-casing map, so we
    // return the tag as the Client Tracker spells it. Fails open: if the
    // tracker read errors, we simply match nothing rather than 500.
    let canonical: Map<string, string> = new Map();
    try {
      const known = await getAllClientTags();
      canonical = new Map(known.map((t) => [t.toUpperCase(), t]));
    } catch {
      canonical = new Map();
    }

    // Keep only the domain's tags that are recognized client tags.
    const clientTags: string[] = [];
    const seen = new Set<string>();
    for (const t of allTags) {
      const key = bareTag(t);
      const canon = canonical.get(key);
      if (canon && !seen.has(key)) {
        seen.add(key);
        clientTags.push(canon);
      }
    }
    clientTags.sort((a, b) => a.localeCompare(b));

    return NextResponse.json({
      domain,
      clientTag: clientTags[0] ?? null,
      clientTags,
      instances: Array.from(instances).sort(),
      allTags: Array.from(allTags).sort(),
      found,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
