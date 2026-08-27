// Client tags that must NEVER receive whitelist emails.
//
// Spencer 2026-08-28: "Is it possible to make an exception in the backend for
// a specific client tag that we don't need to CC and send whitelisting emails
// to them? It's a unique situation where an appointment setting lead
// generation agency is working those DM4PM leads."
//
// DM4PM's replies are handled by an outside agency, so there is no client
// inbox to whitelist against — its domains were queuing since 2026-08-06 and
// failing "no recipients" every morning, which someone then dismissed daily.
//
// Exempt domains are marked sent (so the queue drains and nothing re-queues)
// and no email is composed or sent. Every other replacement step — tagging,
// redirect, campaign attach, client sheet — is untouched.
//
// Matching is on the BARE tag, so "DM4PM" also covers "DM4PM: Leads".
// Env override (comma-separated) so a tag can be added without a deploy.
const DEFAULT_EXEMPT = ["DM4PM"];

export function whitelistExemptTags(): Set<string> {
  const fromEnv = (process.env.WHITELIST_EXEMPT_TAGS || "")
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
  return new Set(fromEnv.length > 0 ? fromEnv : DEFAULT_EXEMPT.map((t) => t.toUpperCase()));
}

/** True when this client tag should skip whitelist emails entirely. */
export function isWhitelistExempt(clientTag: string): boolean {
  const bare = (clientTag.split(":")[0] || clientTag).trim().toUpperCase();
  return whitelistExemptTags().has(bare);
}
