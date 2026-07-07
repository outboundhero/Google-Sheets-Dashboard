import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerSupabaseClient, getSupabaseAdmin } from "@/lib/supabase";

export const maxDuration = 300;

/**
 * GET /api/admin/inboxing-tag-backfill
 *
 * One-off backfill (companion to /api/admin/inboxing-tag-audit): make every
 * ACTIVE Inboxing domain's tags MATCH LeadSync's deliverability_domains.tags
 * (LeadSync is the source of truth). This both adds the missing client tags
 * (the 663 one-directional drift) and removes stale churned-client tags
 * (rfs/mtg/jpd reverse drift).
 *
 * Modes:
 *   ?dry=1            (default) — compute the plan, change nothing
 *   ?apply=1&limit=N  — apply up to N updates (default 150) per request,
 *                       alphabetical by domain; re-run until `remaining` is 0.
 *
 * A domain with LeadSync rows on multiple instances gets the UNION of tags.
 * Domains not in LeadSync are skipped (separate follow-up).
 *
 * Admin-only. Delete this route once the backfill is done.
 */

// ⚠️ Set from the Inboxing API docs before running ?apply=1.
// Placeholder deliberately throws so a blind apply can't fire a guessed write.
const UPDATE_TAGS_ENDPOINT: { method: string; path: (id: string) => string; body: (tags: string[]) => unknown } | null = null;

interface InboxingDomain {
  id: string;
  domain: string;
  status?: string;
  tags?: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function inboxingFetch(path: string, init?: RequestInit): Promise<Response> {
  const key = process.env.INBOXING_API_KEY;
  const base = process.env.INBOXING_BASE_URL || "https://v2.inboxing.com/api/v2";
  if (!key) throw new Error("INBOXING_API_KEY not set");
  let last: Response | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        "X-API-Key": key,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    if (res.ok) return res;
    if (res.status === 429 || res.status >= 500) {
      last = res;
      const ra = parseInt(res.headers.get("retry-after") || "", 10);
      // Inboxing's rate window is per-minute — short backoff burns every
      // attempt inside one throttled window. Wait long enough to clear it.
      const waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 + 500 : 15_000 + attempt * 10_000;
      await sleep(waitMs);
      continue;
    }
    return res;
  }
  return last as Response;
}

async function fetchActiveInboxingDomains(): Promise<InboxingDomain[]> {
  const out: InboxingDomain[] = [];
  const perPage = 100;
  for (let page = 1; page < 500; page++) {
    // No `status=active` param — Inboxing 500s on it; filter client-side.
    const res = await inboxingFetch(`/domains?per_page=${perPage}&page=${page}`);
    if (!res.ok) throw new Error(`Inboxing /domains page ${page}: HTTP ${res.status}`);
    const json = (await res.json()) as { data?: InboxingDomain[] };
    const rows = json.data || [];
    for (const d of rows) {
      if (d?.domain && (d.status || "").toLowerCase() === "active") {
        out.push({ id: String(d.id), domain: d.domain, status: d.status, tags: d.tags || [] });
      }
    }
    if (rows.length < perPage) break;
  }
  return out;
}

const normSet = (tags: string[] | null | undefined) =>
  new Set((tags || []).map((t) => (t || "").trim().toLowerCase()).filter(Boolean));

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
    const apply = searchParams.get("apply") === "1";
    const limit = Math.min(500, Math.max(1, parseInt(searchParams.get("limit") || "150", 10) || 150));

    // 1. Active Inboxing domains with current tags.
    const inboxingDomains = await fetchActiveInboxingDomains();

    // 2. LeadSync tags per domain name (union across instances, keep original casing).
    const supabase = getSupabaseAdmin();
    const leadsyncTags = new Map<string, Map<string, string>>(); // domain → (lower → original)
    {
      const PAGE = 1000;
      let offset = 0;
      while (true) {
        const { data, error } = await supabase
          .from("deliverability_domains")
          .select("domain, tags")
          .range(offset, offset + PAGE - 1);
        if (error) throw new Error(`deliverability_domains read: ${error.message}`);
        if (!data || data.length === 0) break;
        for (const r of data as { domain: string; tags: string[] | null }[]) {
          const k = r.domain.toLowerCase();
          let m = leadsyncTags.get(k);
          if (!m) { m = new Map(); leadsyncTags.set(k, m); }
          for (const t of r.tags || []) {
            const trimmed = (t || "").trim();
            if (trimmed) m.set(trimmed.toLowerCase(), trimmed);
          }
        }
        if (data.length < PAGE) break;
        offset += PAGE;
      }
    }

    // 3. Plan: every active Inboxing domain whose tag SET differs from LeadSync's.
    interface PlanRow { id: string; domain: string; from: string[]; to: string[] }
    const plan: PlanRow[] = [];
    let skippedNotInLeadsync = 0;
    let alreadyInSync = 0;
    for (const d of inboxingDomains) {
      const target = leadsyncTags.get(d.domain.toLowerCase());
      if (!target || target.size === 0) { skippedNotInLeadsync++; continue; }
      const cur = normSet(d.tags);
      const want = new Set(target.keys());
      const same = cur.size === want.size && [...cur].every((t) => want.has(t));
      if (same) { alreadyInSync++; continue; }
      plan.push({ id: d.id, domain: d.domain, from: d.tags || [], to: [...target.values()].sort() });
    }
    plan.sort((a, b) => a.domain.localeCompare(b.domain));

    if (!apply) {
      return NextResponse.json({
        mode: "dry-run",
        totals: {
          active_inboxing_domains: inboxingDomains.length,
          already_in_sync: alreadyInSync,
          to_update: plan.length,
          skipped_not_in_leadsync: skippedNotInLeadsync,
        },
        sample: plan.slice(0, 25),
        note: "Tags will be REPLACED with LeadSync's set (union across instances). Run ?apply=1&limit=150 repeatedly until remaining=0.",
      });
    }

    // 4. Apply (paced ~1/sec; Inboxing rate-limits per-minute).
    if (!UPDATE_TAGS_ENDPOINT) {
      return NextResponse.json({
        error: "UPDATE_TAGS_ENDPOINT not configured — set the method/path/body from the Inboxing API docs first.",
      }, { status: 400 });
    }
    const batch = plan.slice(0, limit);
    const failures: { domain: string; error: string }[] = [];
    let updated = 0;
    for (const row of batch) {
      try {
        const res = await inboxingFetch(UPDATE_TAGS_ENDPOINT.path(row.id), {
          method: UPDATE_TAGS_ENDPOINT.method,
          body: JSON.stringify(UPDATE_TAGS_ENDPOINT.body(row.to)),
        });
        if (!res.ok) {
          const t = await res.text().catch(() => "");
          failures.push({ domain: row.domain, error: `HTTP ${res.status} ${t.slice(0, 150)}` });
        } else {
          updated++;
        }
      } catch (e) {
        failures.push({ domain: row.domain, error: e instanceof Error ? e.message : "failed" });
      }
      await sleep(1000);
    }
    return NextResponse.json({
      mode: "apply",
      updated,
      failed: failures.length,
      failures: failures.slice(0, 30),
      remaining: plan.length - batch.length,
      note: plan.length - batch.length > 0 ? "Re-run ?apply=1 to continue." : "Done — re-run the audit to verify.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Backfill failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
