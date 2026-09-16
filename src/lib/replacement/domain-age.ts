import { getSupabaseAdmin } from "@/lib/supabase";

// Warmup age must survive re-uploads and instance moves. Bison stamps
// `domain_created_at` with the date the domain landed in THAT workspace, so a
// domain Inboxing re-pushes after a delete, or one moved between instances,
// reads as brand new and every 21-day gate (fill, true-up, stock, orphan
// attach) treats months-old senders as still warming. The sync freezes each
// domain's first-ever-seen date in `domain_first_created` (keyed by domain,
// first write wins); readers take the EARLIER of that and the Bison date.
//
// Ordered pagination on purpose — an unordered .range() loop skips rows.

const PAGE = 1000;

export type FirstCreatedMap = Map<string, string>;

export async function loadFirstCreated(): Promise<FirstCreatedMap> {
  const supabase = getSupabaseAdmin();
  const map: FirstCreatedMap = new Map();
  for (let off = 0; ; off += PAGE) {
    const { data, error } = await supabase
      .from("domain_first_created")
      .select("domain,first_created_at")
      .order("domain", { ascending: true })
      .range(off, off + PAGE - 1);
    if (error) throw new Error(`domain_first_created: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data as { domain: string; first_created_at: string | null }[]) {
      if (r.first_created_at) map.set(r.domain.toLowerCase(), r.first_created_at);
    }
    if (data.length < PAGE) break;
  }
  return map;
}

/** Earliest known creation date for a domain: frozen first-seen date if older, else the Bison date. */
export function effectiveCreatedAt(
  domain: string,
  bisonCreatedAt: string | null | undefined,
  firstCreated: FirstCreatedMap,
): string | null {
  const first = firstCreated.get(domain.toLowerCase()) ?? null;
  if (!first) return bisonCreatedAt ?? null;
  if (!bisonCreatedAt) return first;
  return new Date(first).getTime() < new Date(bisonCreatedAt).getTime() ? first : bisonCreatedAt;
}

export function effectiveAgeDays(
  domain: string,
  bisonCreatedAt: string | null | undefined,
  firstCreated: FirstCreatedMap,
  nowMs = Date.now(),
): number {
  const created = effectiveCreatedAt(domain, bisonCreatedAt, firstCreated);
  if (!created) return 0;
  return Math.floor((nowMs - new Date(created).getTime()) / 86_400_000);
}
