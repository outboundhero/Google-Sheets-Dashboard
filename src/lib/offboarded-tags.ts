// Client tags belonging to CHURNED clients (any row in client_offboarding_actions
// — pending, confirmed, skipped or auto-fired; every row there means the churn
// date has been reached). The automatic tag re-adders (reconnect tag restore,
// conform-tags, reconnect-worker conform step) consult this set so an
// offboarded client's tag can never be resurrected onto inboxes — the root
// cause of Spencer's daily manual de-tagging (2026-07-29 Loom).
//
// NOTE: if a churned client ever RETURNS, delete their row from
// client_offboarding_actions — otherwise automatic tagging stays off for them
// (manual tagging always works regardless).
import { getSupabaseAdmin } from "@/lib/supabase";

let cache: { set: Set<string>; at: number } | null = null;
const TTL_MS = 60_000; // webhook hot-path — avoid a query per event

/** UPPERCASE bare client tags (no ": Leads" suffixes) of churned clients. */
export async function getOffboardedClientTags(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.set;
  const set = new Set<string>();
  try {
    const { data } = await getSupabaseAdmin()
      .from("client_offboarding_actions")
      .select("client_abbr");
    for (const r of data || []) {
      const t = String(r.client_abbr || "").trim().toUpperCase();
      if (t) set.add(t);
    }
  } catch { /* fail open — an error must never block tag restore entirely */ }
  cache = { set, at: Date.now() };
  return set;
}

/** Does this tag NAME (e.g. "SQFT" or "SQFT: Leads") belong to an offboarded client? */
export function isOffboardedTagName(name: string | null | undefined, offboarded: Set<string>): boolean {
  if (!name) return false;
  const bare = name.split(":")[0].trim().toUpperCase();
  return bare.length > 0 && offboarded.has(bare);
}
