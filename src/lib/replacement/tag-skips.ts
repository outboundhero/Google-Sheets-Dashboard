// Hidden client tags for the wrong-instance card (Spencer 2026-08-20):
// "we would like to hide/skip client tags if we want so that they don't
//  continue showing up but we can retrieve it by ... a toggle field, to add it
//  back to the 'wrong instance – move to the right one' automation".
//
// Some flagged clients are deliberate — a tag that legitimately runs on the
// other group will be re-flagged on every check, and there was no way to say
// "this one is fine" short of moving domains nobody wanted moved. Hiding is
// display-only and fully reversible: the detector still computes the client,
// the card just files it under "Hidden" until it's restored.
//
// Persistence: replacement_tag_skips (client_tag) — same shape as the
// per-domain replacement_skips table.
import { getSupabaseAdmin } from "@/lib/supabase";

export interface TagSkipRow {
  client_tag: string;
  scope: string;
  reason: string | null;
  skipped_at: string;
}

/** Default scope — one table can serve other cards later without a migration. */
export const WRONG_INSTANCE_SCOPE = "wrong-instance";

/** All hidden tags for a scope, newest first. Never throws: a missing table
 *  means nothing is hidden, which is how the card behaved before this. */
export async function getHiddenTags(scope = WRONG_INSTANCE_SCOPE): Promise<TagSkipRow[]> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("replacement_tag_skips")
      .select("client_tag,scope,reason,skipped_at")
      .eq("scope", scope)
      .order("skipped_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data || [];
  } catch {
    return [];
  }
}

/** Fast membership set of UPPERCASE tags. */
export async function getHiddenTagSet(scope = WRONG_INSTANCE_SCOPE): Promise<Set<string>> {
  const rows = await getHiddenTags(scope);
  return new Set(rows.map((r) => r.client_tag.trim().toUpperCase()));
}

export async function hideTags(
  tags: string[],
  reason: string | null = null,
  scope = WRONG_INSTANCE_SCOPE,
): Promise<number> {
  const rows = tags
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean)
    .map((client_tag) => ({ client_tag, scope, reason, skipped_at: new Date().toISOString() }));
  if (rows.length === 0) return 0;
  const { error } = await getSupabaseAdmin()
    .from("replacement_tag_skips")
    .upsert(rows, { onConflict: "client_tag,scope" });
  if (error) throw new Error(error.message);
  return rows.length;
}

export async function unhideTags(tags: string[], scope = WRONG_INSTANCE_SCOPE): Promise<number> {
  const list = tags.map((t) => t.trim().toUpperCase()).filter(Boolean);
  if (list.length === 0) return 0;
  const { error } = await getSupabaseAdmin()
    .from("replacement_tag_skips")
    .delete()
    .eq("scope", scope)
    .in("client_tag", list);
  if (error) throw new Error(error.message);
  return list.length;
}
