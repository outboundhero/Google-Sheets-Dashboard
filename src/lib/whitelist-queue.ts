// Per-client queue of secondary domains awaiting a whitelist email.
// Table: whitelist_queue (client_tag, domain) PK, status 'queued' | 'sent'.
// The PK is the dedup: a domain already queued/sent for a client is never
// duplicated or re-emailed (see enqueueDomains' ignoreDuplicates).
import { getSupabaseAdmin } from "@/lib/supabase";

const norm = (domains: string[]) =>
  [...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))];

/**
 * Add domains to a client's queue. Already-queued or already-sent domains are
 * left untouched (ignoreDuplicates) so nothing gets emailed twice.
 * Returns how many rows were newly queued vs skipped (already present).
 */
export async function enqueueDomains(
  clientTag: string,
  domains: string[],
): Promise<{ queued: number; skipped: number }> {
  const list = norm(domains);
  if (list.length === 0) return { queued: 0, skipped: 0 };

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("whitelist_queue")
    .upsert(
      list.map((domain) => ({ client_tag: clientTag, domain, status: "queued" })),
      { onConflict: "client_tag,domain", ignoreDuplicates: true },
    )
    .select("domain");
  if (error) throw new Error(error.message);

  const queued = data?.length ?? 0;
  return { queued, skipped: list.length - queued };
}

/** All 'queued' rows grouped by client_tag. */
export async function getQueuedByClient(): Promise<Record<string, string[]>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("whitelist_queue")
    .select("client_tag, domain")
    .eq("status", "queued");
  if (error) throw new Error(error.message);

  const grouped: Record<string, string[]> = {};
  for (const row of data || []) {
    (grouped[row.client_tag] ||= []).push(row.domain);
  }
  return grouped;
}

/** Of `domains`, return those NOT already sent to this client (send-now dedup). */
export async function filterUnsent(clientTag: string, domains: string[]): Promise<string[]> {
  const list = norm(domains);
  if (list.length === 0) return [];

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("whitelist_queue")
    .select("domain")
    .eq("client_tag", clientTag)
    .eq("status", "sent")
    .in("domain", list);
  if (error) throw new Error(error.message);

  const alreadySent = new Set((data || []).map((r) => r.domain));
  return list.filter((d) => !alreadySent.has(d));
}

/** Mark domains as sent for a client (used by send-now and the cron). */
export async function markSent(clientTag: string, domains: string[]): Promise<void> {
  const list = norm(domains);
  if (list.length === 0) return;

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("whitelist_queue")
    .upsert(
      list.map((domain) => ({ client_tag: clientTag, domain, status: "sent", sent_at: now })),
      { onConflict: "client_tag,domain" },
    );
  if (error) throw new Error(error.message);
}
