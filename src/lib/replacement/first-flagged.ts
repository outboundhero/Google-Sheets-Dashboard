// First-flagged dates (Spencer Aug-11: "show us when it got added to the
// flagged system — the date, and filter by it"). Flagging itself is computed
// on the fly, so this tiny table remembers the first time each (instance,
// domain) ever flagged. Insert-only via ignoreDuplicates — the first date
// wins forever; rows are never updated or deleted (a later re-flag after
// recovery keeps the original date, which is what "when it got added" means).
// Everything fails open: the table not existing yet must never break a build.
import { getSupabaseAdmin } from "@/lib/supabase";

export async function recordFirstFlagged(entries: { instance: string; domain: string }[]): Promise<void> {
  if (entries.length === 0) return;
  try {
    const supabase = getSupabaseAdmin();
    const rows = entries.map((e) => ({ instance: e.instance, domain: e.domain.toLowerCase() }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase
        .from("replacement_first_flagged")
        .upsert(rows.slice(i, i + 500), { onConflict: "instance,domain", ignoreDuplicates: true });
      if (error) throw new Error(error.message);
    }
  } catch {
    // fail open — dates are informational
  }
}

/** Map keyed `${instance}:${domain.toLowerCase()}` → first_flagged_at ISO string. */
export async function getFirstFlaggedMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const supabase = getSupabaseAdmin();
    let off = 0;
    while (true) {
      const { data, error } = await supabase
        .from("replacement_first_flagged")
        .select("instance,domain,first_flagged_at")
        .range(off, off + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      for (const r of data) map.set(`${r.instance}:${String(r.domain).toLowerCase()}`, r.first_flagged_at);
      if (data.length < 1000) break;
      off += 1000;
    }
  } catch {
    // fail open — table may not exist yet
  }
  return map;
}
