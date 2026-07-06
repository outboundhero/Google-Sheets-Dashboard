import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerSupabaseClient, getSupabaseAdmin } from "@/lib/supabase";

export const maxDuration = 300;

/**
 * GET /api/admin/inboxing-tag-audit
 *
 * One-off data audit (not a product feature): for every ACTIVE domain on the
 * Inboxing account, compare the tags Inboxing has against the tags LeadSync
 * has for the same domain in deliverability_domains. Answers "are the two
 * systems' tags in sync?"
 *
 * Comparison is case-insensitive and order-insensitive; raw values are
 * reported so casing drift is still visible in the output.
 *
 * Query params:
 *   ?full=1   include the complete mismatch list (default caps at 100 rows)
 *
 * Admin-only. Read-only. Delete this route once the audit is done.
 */

interface InboxingDomain {
  id: string;
  domain: string;
  status?: string;
  tags?: string[];
}

interface LeadsyncDomainRow {
  instance: string;
  domain: string;
  tags: string[] | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchActiveInboxingDomains(): Promise<InboxingDomain[]> {
  const key = process.env.INBOXING_API_KEY;
  const base = process.env.INBOXING_BASE_URL || "https://v2.inboxing.com/api/v2";
  if (!key) throw new Error("INBOXING_API_KEY not set");

  const out: InboxingDomain[] = [];
  const perPage = 100;
  for (let page = 1; page < 500; page++) {
    let res: Response | null = null;
    // Light retry on 429/5xx.
    for (let attempt = 0; attempt < 5; attempt++) {
      res = await fetch(`${base}/domains?status=active&per_page=${perPage}&page=${page}`, {
        headers: { Accept: "application/json", "X-API-Key": key },
      });
      if (res.ok) break;
      if (res.status === 429 || res.status >= 500) {
        await sleep(Math.min(10_000, 800 * 2 ** attempt));
        continue;
      }
      throw new Error(`Inboxing /domains page ${page}: HTTP ${res.status}`);
    }
    if (!res || !res.ok) throw new Error(`Inboxing /domains page ${page}: exhausted retries`);
    const json = (await res.json()) as { data?: InboxingDomain[] };
    const rows = json.data || [];
    for (const d of rows) {
      if (d?.domain) out.push({ id: String(d.id), domain: d.domain, status: d.status, tags: d.tags || [] });
    }
    if (rows.length < perPage) break;
  }
  return out;
}

function normalizeTagSet(tags: string[] | null | undefined): Set<string> {
  return new Set((tags || []).map((t) => (t || "").trim().toLowerCase()).filter(Boolean));
}

export async function GET(request: Request) {
  try {
    const cookieStore = await cookies();
    const supabaseAuth = createServerSupabaseClient(cookieStore);
    const { data: { user } } = await supabaseAuth.auth.getUser();
    const role = user?.app_metadata?.role || user?.user_metadata?.role;
    if (!user || role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const { searchParams } = new URL(request.url);
    const full = searchParams.get("full") === "1";

    // 1. All ACTIVE domains on Inboxing, with their tags.
    const inboxingDomains = await fetchActiveInboxingDomains();

    // 2. All LeadSync domains (any instance) with tags.
    const supabase = getSupabaseAdmin();
    const leadsyncByName = new Map<string, LeadsyncDomainRow[]>();
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
        for (const r of data as LeadsyncDomainRow[]) {
          const k = r.domain.toLowerCase();
          let arr = leadsyncByName.get(k);
          if (!arr) { arr = []; leadsyncByName.set(k, arr); }
          arr.push(r);
        }
        if (data.length < PAGE) break;
        offset += PAGE;
      }
    }

    // 3. Compare.
    interface Mismatch {
      domain: string;
      instance: string;
      inboxing_tags: string[];
      leadsync_tags: string[];
      only_in_inboxing: string[];
      only_in_leadsync: string[];
    }
    const mismatches: Mismatch[] = [];
    const notInLeadsync: string[] = [];
    let inSync = 0;
    // Aggregate: which tag VALUES are drifting, and how often.
    const onlyInboxingCounts = new Map<string, number>();
    const onlyLeadsyncCounts = new Map<string, number>();

    for (const d of inboxingDomains) {
      const lsRows = leadsyncByName.get(d.domain.toLowerCase());
      if (!lsRows || lsRows.length === 0) {
        notInLeadsync.push(d.domain);
        continue;
      }
      const inboxingSet = normalizeTagSet(d.tags);
      for (const ls of lsRows) {
        const leadsyncSet = normalizeTagSet(ls.tags);
        const onlyInboxing = [...inboxingSet].filter((t) => !leadsyncSet.has(t));
        const onlyLeadsync = [...leadsyncSet].filter((t) => !inboxingSet.has(t));
        if (onlyInboxing.length === 0 && onlyLeadsync.length === 0) {
          inSync++;
          continue;
        }
        for (const t of onlyInboxing) onlyInboxingCounts.set(t, (onlyInboxingCounts.get(t) ?? 0) + 1);
        for (const t of onlyLeadsync) onlyLeadsyncCounts.set(t, (onlyLeadsyncCounts.get(t) ?? 0) + 1);
        mismatches.push({
          domain: d.domain,
          instance: ls.instance,
          inboxing_tags: d.tags || [],
          leadsync_tags: ls.tags || [],
          only_in_inboxing: onlyInboxing,
          only_in_leadsync: onlyLeadsync,
        });
      }
    }

    const sortCounts = (m: Map<string, number>) =>
      [...m.entries()].sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count }));

    return NextResponse.json({
      totals: {
        active_inboxing_domains: inboxingDomains.length,
        found_in_leadsync: inboxingDomains.length - notInLeadsync.length,
        not_in_leadsync: notInLeadsync.length,
        comparisons_in_sync: inSync,
        comparisons_mismatched: mismatches.length,
      },
      // Which tag values drift, and how often — the quickest read on the problem.
      drift_summary: {
        tags_only_in_inboxing: sortCounts(onlyInboxingCounts),
        tags_only_in_leadsync: sortCounts(onlyLeadsyncCounts),
      },
      not_in_leadsync_sample: notInLeadsync.slice(0, 50),
      mismatches: full ? mismatches : mismatches.slice(0, 100),
      mismatches_truncated: !full && mismatches.length > 100,
      note: "Tags compared case-insensitively. Pass ?full=1 for the complete mismatch list.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Audit failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
