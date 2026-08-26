// A hand-applied "Burnt" tag in Bison is a human verdict, and it outranks our
// metrics: a domain with too little history to be judged (99 sends) can still
// have been burnt by someone who knows. Vicky 2026-08-27, after the first
// supervised run handed JPCHI a domain tagged "Burnt" — the rules allowed it
// (Spencer's .info OK, Nick's low-activity OK) but nobody wants it.
//
// Used by every reserve pool (plan, true-up) and the deliverability Reserve
// view so the answer is the same everywhere. Pure function, client-safe.
export function hasBurntTag(tags: readonly unknown[] | null | undefined): boolean {
  for (const t of tags || []) {
    const name = typeof t === "string" ? t : (t as { name?: string } | null)?.name;
    if ((name || "").trim().toLowerCase() === "burnt") return true;
  }
  return false;
}
