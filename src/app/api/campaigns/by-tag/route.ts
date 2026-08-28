import { NextResponse } from "next/server";
import { bisonFetch, resolveInstances } from "@/lib/bison";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

export const maxDuration = 60;

// GET /api/campaigns/by-tag?tags=CVJORL,DBSTN&instances=<csv>
//
// LIVE campaign lookup for a set of client tags, straight from Bison.
//
// Why this exists: the bulk-tag dialog's campaign step used to read
// /api/campaigns, which serves our Supabase mirror. That mirror is rebuilt by
// a once-a-day per-instance cron, so a campaign created or renamed in the last
// 24h simply wasn't there — the dialog offered a partial list and the domains
// had to be attached by hand in EmailBison. CVJORL, 2026-08-28: three main
// campaigns created minutes earlier were invisible while the three older
// Nurture ones showed up.
//
// Scope is bounded by tag: Bison filters server-side on `search=<tag>`, so this
// is a handful of small requests, not a full campaign crawl. Falls back to
// returning whatever instances did answer — a single instance being down must
// not blank the whole list.

const PER_PAGE = 100;
const MAX_PAGES = 5;          // 500 campaigns for one tag is already implausible
const MAX_TAGS = 10;

export interface LiveCampaign {
  id: number;
  instance: BisonInstanceSlug;
  name: string;
  status: string;
  client_tag: string;
}

/** Campaigns whose name starts with `<tag>:` in one instance. */
async function campaignsForTag(instance: BisonInstanceSlug, tag: string): Promise<LiveCampaign[]> {
  const out: LiveCampaign[] = [];
  const prefix = `${tag.toLowerCase()}:`;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await bisonFetch(
      instance,
      `/campaigns?search=${encodeURIComponent(tag)}&page=${page}&per_page=${PER_PAGE}`,
    );
    if (!res.ok) break;
    const json = await res.json().catch(() => null);
    const rows: Record<string, unknown>[] = json?.data || [];
    if (rows.length === 0) break;

    for (const c of rows) {
      const name = String(c.name ?? "");
      // `search` is a fuzzy contains — keep only real "TAG: ..." owners so a
      // tag never picks up another client's campaign that merely mentions it.
      if (!name.toLowerCase().startsWith(prefix)) continue;
      const colonIdx = name.indexOf(":");
      out.push({
        id: c.id as number,
        instance,
        name,
        status: String(c.status ?? ""),
        client_tag: colonIdx > 0 ? name.substring(0, colonIdx).trim() : "",
      });
    }

    const lastPage = json?.meta?.last_page ?? 1;
    if (page >= lastPage) break;
  }
  return out;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const instances = resolveInstances(searchParams);
    const tags = [
      ...new Set(
        (searchParams.get("tags") || "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    ].slice(0, MAX_TAGS);

    if (tags.length === 0) return NextResponse.json({ campaigns: [], tags: [], instances: [] });

    const jobs: { instance: BisonInstanceSlug; tag: string }[] = [];
    for (const instance of instances) for (const tag of tags) jobs.push({ instance, tag });

    const results = await Promise.allSettled(jobs.map((j) => campaignsForTag(j.instance, j.tag)));

    const campaigns: LiveCampaign[] = [];
    const seen = new Set<string>();
    let failed = 0;
    for (const r of results) {
      if (r.status !== "fulfilled") { failed++; continue; }
      for (const c of r.value) {
        const key = `${c.instance}:${c.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        campaigns.push(c);
      }
    }

    return NextResponse.json({
      campaigns,
      tags,
      instances,
      failedLookups: failed,
      source: "bison-live",
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "live campaign lookup failed" },
      { status: 500 },
    );
  }
}
