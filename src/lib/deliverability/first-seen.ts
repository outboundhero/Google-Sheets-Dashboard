import { getSupabaseAdmin } from "@/lib/supabase";

// Warmup-days memory across instance moves. The Deliverability page and the
// replacement gates take a domain's warmup start from domain_first_created,
// but only the every-2-days crawl wrote it, and that crawl's passes now take
// weeks (B2B #1's current one started Sep 11). On 2026-10-17, 502 domains had
// no entry, so moving one restarted its warmup clock (Nick: 25 of 96 recent
// moves, e.g. the CRJS/BWCS domains moved B2B #1 → B2B #2 on Oct 6 showed
// "11d left" after sending since June). Every writer of a domain row now
// records here too: the move (from the source, before it can be deleted), the
// manual Sync and the domain import.
//
// Keeps the EARLIEST date per domain: the copy on the instance a domain moved
// to never pushes its start forward, and an earlier sighting corrects an entry
// that was recorded after a reset.

export interface FirstSeen {
  domain: string;
  createdAt: string | null | undefined;
  instance: string;
}

/** Best-effort: never throws, so it can't fail a sync, import or move. */
export async function rememberFirstSeen(rows: FirstSeen[]): Promise<void> {
  const best = new Map<string, { at: number; createdAt: string; instance: string }>();
  for (const r of rows) {
    const at = r.createdAt ? Date.parse(r.createdAt) : NaN;
    if (isNaN(at)) continue;
    const domain = r.domain.toLowerCase();
    const cur = best.get(domain);
    if (!cur || at < cur.at) best.set(domain, { at, createdAt: r.createdAt!, instance: r.instance });
  }
  if (best.size === 0) return;
  try {
    const supabase = getSupabaseAdmin();
    const names = [...best.keys()];
    const existing = new Map<string, number>();
    for (let i = 0; i < names.length; i += 200) {
      const { data, error } = await supabase
        .from("domain_first_created")
        .select("domain,first_created_at")
        .in("domain", names.slice(i, i + 200));
      if (error) throw new Error(error.message);
      for (const r of data || []) existing.set(r.domain as string, Date.parse(r.first_created_at as string));
    }
    const writes = [...best.entries()]
      .filter(([domain, r]) => !(r.at >= (existing.get(domain) ?? Infinity)))
      .map(([domain, r]) => ({ domain, first_created_at: r.createdAt, first_instance: r.instance }));
    for (let i = 0; i < writes.length; i += 500) {
      const { error } = await supabase
        .from("domain_first_created")
        .upsert(writes.slice(i, i + 500), { onConflict: "domain" });
      if (error) throw new Error(error.message);
    }
  } catch (e) {
    console.error("[first-seen] could not record:", e instanceof Error ? e.message : e);
  }
}
