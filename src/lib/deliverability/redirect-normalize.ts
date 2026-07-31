// Shared normalization for redirect URLs entered by humans.
//
// Why this exists: someone typing "n/a" (or "none", "-", blank) into a redirect
// field used to be stored verbatim and pushed to the provider as a *REGULAR*
// redirect pointing at the literal string "n/a". Inboxing's Ramon flagged a
// batch of domains stuck that way. Anywhere we accept a redirect from a person,
// route it through here so those sentinels collapse to a real "no redirect"
// (the provider's NONE endpoint) instead of a bogus URL.

// Words a human types meaning "no redirect". Compared case-insensitively after
// trimming. Empty / whitespace is handled separately (see meansNoRedirect).
const NO_REDIRECT_WORDS = new Set([
  "n/a", "na", "n.a.", "n.a", "none", "no", "null", "nil",
  "-", "—", "--", "not applicable", "tbd", "n\\a",
]);

/**
 * Input guard. True when a user-entered value means "no redirect" — including
 * blank/undefined. Use at the point of accepting a redirect from a request so
 * the provider gets its NONE call instead of a REGULAR redirect to garbage.
 */
export function meansNoRedirect(raw: string | null | undefined): boolean {
  if (raw == null) return true;
  const v = raw.trim().toLowerCase();
  return v === "" || NO_REDIRECT_WORDS.has(v);
}

/**
 * Cleanup detector. True only for a STORED value that is a bogus "n/a"-type
 * redirect — i.e. non-blank but a no-redirect sentinel. Blank/null are already
 * fine and return false (nothing to repair).
 */
export function isBogusStoredRedirect(raw: string | null | undefined): boolean {
  if (raw == null) return false;
  const v = raw.trim().toLowerCase();
  return v !== "" && NO_REDIRECT_WORDS.has(v);
}

/**
 * Normalize a user-entered redirect. Returns null when it means "no redirect"
 * (providers must then be called with their NONE endpoint), or the trimmed
 * string otherwise. Does NOT validate the URL scheme — callers still enforce
 * http(s):// on the non-null result.
 */
export function normalizeRedirect(raw: string | null | undefined): string | null {
  if (meansNoRedirect(raw)) return null;
  return raw!.trim();
}
