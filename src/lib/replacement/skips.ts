// Skip/Unflag for the replacement queue — Spencer's precondition for turning
// automatic replacement on (his bounce-spike false positives, Jul-30):
//   • a SKIPPED domain is never auto-replaced, removed, or counted as burnt;
//   • it stays in its campaigns untouched and keeps showing health;
//   • if its trailing metrics recover it simply stops being flagged (the skip
//     row stays, harmless);
//   • after UNSKIP it's re-evaluated on the next plan build like any domain.
// Persistence: replacement_skips (instance, domain) — tiny table, read by
// buildReplacementPlan on every build.
import { getSupabaseAdmin } from "@/lib/supabase";

export interface SkipRow {
  instance: string;
  domain: string;
  reason: string | null;
  skipped_at: string;
}

const key = (instance: string, domain: string) => `${instance}:${domain.toLowerCase()}`;

/** All skip rows, newest first. */
export async function getSkips(): Promise<SkipRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("replacement_skips")
    .select("instance,domain,reason,skipped_at")
    .order("skipped_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

/** Fast membership set: "instance:domain" (domain lowercased). */
export async function getSkipSet(): Promise<Set<string>> {
  try {
    const rows = await getSkips();
    return new Set(rows.map((r) => key(r.instance, r.domain)));
  } catch {
    // Missing table / transient error → no skips (fail open, same as before
    // the feature existed). Never let the skip layer break a plan build.
    return new Set();
  }
}

export function skipKey(instance: string, domain: string): string {
  return key(instance, domain);
}

export async function addSkips(
  entries: { instance: string; domain: string; reason?: string | null }[],
): Promise<number> {
  if (entries.length === 0) return 0;
  const { error } = await getSupabaseAdmin().from("replacement_skips").upsert(
    entries.map((e) => ({
      instance: e.instance,
      domain: e.domain.toLowerCase(),
      reason: e.reason ?? null,
      skipped_at: new Date().toISOString(),
    })),
    { onConflict: "instance,domain" },
  );
  if (error) throw new Error(error.message);
  return entries.length;
}

export async function removeSkips(entries: { instance: string; domain: string }[]): Promise<number> {
  if (entries.length === 0) return 0;
  const supabase = getSupabaseAdmin();
  for (const e of entries) {
    const { error } = await supabase
      .from("replacement_skips")
      .delete()
      .eq("instance", e.instance)
      .eq("domain", e.domain.toLowerCase());
    if (error) throw new Error(error.message);
  }
  return entries.length;
}
