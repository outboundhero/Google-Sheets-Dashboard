import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { getSupabaseAdmin } from "@/lib/supabase";
import { normalizeDomain } from "@/lib/domain-inventory";

// POST /api/domains/inventory/import  (admin-only via middleware)
// Body: { text: string }  — pasted CSV or newline/comma-separated domains.
// Stores as source='manual' (manual=true). Domains already present as Porkbun
// keep their Porkbun source but are flagged manual=true.
export const maxDuration = 60;

const CACHE_KEY = "domain-inventory:v1";

function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function parseList(text: string): { domains: string[]; skippedInvalid: number; duplicates: number } {
  const tokens: string[] = [];
  const lines = text.split(/\r?\n/);
  // Detect a CSV header row containing "domain".
  let domainCol = -1;
  if (lines.length > 0 && lines[0].includes(",")) {
    const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
    const idx = header.findIndex((h) => h === "domain" || h === "domains");
    if (idx >= 0) domainCol = idx;
  }
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    if (i === 0 && domainCol >= 0) return; // skip header
    if (domainCol >= 0) {
      const cell = line.split(",")[domainCol];
      if (cell) tokens.push(cell);
    } else {
      // split each line on commas too (handles comma-separated single line)
      for (const part of line.split(",")) tokens.push(part);
    }
  });

  const seen = new Set<string>();
  let skippedInvalid = 0;
  let duplicates = 0;
  const domains: string[] = [];
  for (const t of tokens) {
    const d = normalizeDomain(t);
    if (!d) { if (t.trim()) skippedInvalid++; continue; }
    if (seen.has(d)) { duplicates++; continue; }
    seen.add(d);
    domains.push(d);
  }
  return { domains, skippedInvalid, duplicates };
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const text = typeof body?.text === "string" ? body.text : "";
    if (!text.trim()) {
      return NextResponse.json({ error: "text is required" }, { status: 400 });
    }
    const createdBy = typeof body?.createdBy === "string" ? body.createdBy : null;

    const { domains, skippedInvalid, duplicates } = parseList(text);
    if (domains.length === 0) {
      return NextResponse.json({ added: 0, updated: 0, skippedInvalid, duplicates });
    }

    const supabase = getSupabaseAdmin();

    // Which of these already exist (any source)?
    const existing = new Map<string, string>(); // domain -> source
    for (let i = 0; i < domains.length; i += 200) {
      const slice = domains.slice(i, i + 200);
      const { data } = await supabase.from("domain_inventory").select("domain, source").in("domain", slice);
      for (const r of data || []) existing.set(r.domain as string, r.source as string);
    }

    const nowIso = new Date().toISOString();
    const newRows = domains
      .filter((d) => !existing.has(d))
      .map((d) => ({
        domain: d,
        source: "manual",
        manual: true,
        tld: `.${d.split(".").pop()}`,
        created_by: createdBy,
        first_seen_at: nowIso,
        last_synced_at: nowIso,
      }));
    const updateDomains = domains.filter((d) => existing.has(d));

    let added = 0;
    for (let i = 0; i < newRows.length; i += 500) {
      const { data, error } = await supabase
        .from("domain_inventory")
        .upsert(newRows.slice(i, i + 500), { onConflict: "domain" })
        .select("domain");
      if (error) throw new Error(error.message);
      added += data?.length ?? 0;
    }

    // Flag already-present domains as manual too (keep their existing source).
    let updated = 0;
    for (let i = 0; i < updateDomains.length; i += 200) {
      const { error, count } = await supabase
        .from("domain_inventory")
        .update({ manual: true }, { count: "exact" })
        .in("domain", updateDomains.slice(i, i + 200));
      if (!error) updated += count ?? 0;
    }

    const redis = getRedis();
    if (redis) await redis.del(CACHE_KEY);

    return NextResponse.json({ added, updated, skippedInvalid, duplicates });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
