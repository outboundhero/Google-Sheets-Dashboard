// Duplicate-domain detection across the 4 Bison instances. The same domain
// living in more than one instance means overlapping infrastructure; Spencer
// wants to pick which instance to strip it from (remove senders from campaigns
// now, delete from that instance after a 4-day grace). Detection is a cheap
// read of deliverability_domains (one row per instance,domain, with inbox_count).
import { getSupabaseAdmin } from "@/lib/supabase";
import { ALL_INSTANCE_SLUGS } from "@/lib/bison-instances";

export const DUP_GRACE_DAYS = 3;

export interface DupInstance {
  instance: string;
  inboxes: number;
  tags: string[];
  createdAt: string | null; // domain_created_at ISO, or null
  sent: number;             // emails sent by all senders under this domain IN THIS instance
  replied: number;          // replies received by all senders under this domain IN THIS instance
}
export interface DuplicateDomain { domain: string; instances: DupInstance[] }

/** Domains present in 2+ instances, with per-instance inbox counts, tags, created date, and sent/reply totals. */
export async function getDuplicateDomains(): Promise<DuplicateDomain[]> {
  const supabase = getSupabaseAdmin();
  const map = new Map<string, DupInstance[]>();
  let off = 0;
  while (true) {
    const { data } = await supabase
      .from("deliverability_domains")
      .select("instance,domain,inbox_count,tags,domain_created_at,total_sent,total_replied")
      .in("instance", ALL_INSTANCE_SLUGS)
      .range(off, off + 999);
    if (!data || data.length === 0) break;
    for (const r of data) {
      const arr = map.get(r.domain) || [];
      arr.push({
        instance: r.instance,
        inboxes: r.inbox_count || 0,
        tags: Array.isArray(r.tags) ? r.tags : [],
        createdAt: r.domain_created_at ?? null,
        sent: r.total_sent || 0,
        replied: r.total_replied || 0,
      });
      map.set(r.domain, arr);
    }
    if (data.length < 1000) break;
    off += 1000;
  }
  const dups: DuplicateDomain[] = [];
  for (const [domain, insts] of map) {
    if (insts.length > 1) dups.push({ domain, instances: insts.sort((a, b) => a.instance.localeCompare(b.instance)) });
  }
  dups.sort((a, b) => a.domain.localeCompare(b.domain));
  return dups;
}

// ── Scheduled deletions (post-removal 4-day grace) ───────────────────────────
export interface PendingDeletion { instance: string; domain: string; scheduledAt: string; status: string }

export async function scheduleDeletions(
  entries: { instance: string; domain: string }[],
  opts: { graceDays?: number; source?: string } = {},
): Promise<void> {
  if (entries.length === 0) return;
  const supabase = getSupabaseAdmin();
  const graceDays = opts.graceDays ?? DUP_GRACE_DAYS;
  // `source` tags where the schedule came from: "duplicate" (this card) or
  // "manual" (the deliverability Delete button's "delete in 5 days"). The
  // fire-scheduled-deletions cron fires ALL pending rows regardless of source;
  // this only keeps the two flows' pending lists from bleeding into each other.
  const source = opts.source ?? "duplicate";
  const at = new Date(Date.now() + graceDays * 86400000).toISOString();
  const { error } = await supabase.from("duplicate_domain_deletions").upsert(
    entries.map((e) => ({ instance: e.instance, domain: e.domain, scheduled_at: at, status: "pending", source })),
    { onConflict: "instance,domain" },
  );
  if (error) throw new Error(error.message);
}

export async function getPendingDeletions(): Promise<PendingDeletion[]> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("duplicate_domain_deletions")
    .select("instance,domain,scheduled_at,status")
    .eq("status", "pending")
    // "duplicate" = scheduled from this card; "move" = post-move verified
    // source-copy auto-deletes (24h grace) — both cancellable here. The manual
    // Delete button's "manual" rows stay out (they have their own flow).
    .in("source", ["duplicate", "move"])
    .order("scheduled_at");
  return (data || []).map((r) => ({ instance: r.instance, domain: r.domain, scheduledAt: r.scheduled_at, status: r.status }));
}

/**
 * Drop the remaining grace on pending rows so the executor picks them up on its
 * next pass (Spencer 2026-08-12: "force these through"). Deliberately only
 * moves the clock — the actual deleting stays with the one verified executor
 * (fire-scheduled-deletions), which is why this is safe to call on hundreds of
 * rows at once. `targets` limits it; omitted = every pending duplicate/move row.
 */
export async function forceDeletionsNow(
  targets?: { instance: string; domain: string }[],
): Promise<number> {
  const supabase = getSupabaseAdmin();
  const nowIso = new Date().toISOString();
  if (targets && targets.length > 0) {
    let moved = 0;
    for (const t of targets) {
      const { data } = await supabase
        .from("duplicate_domain_deletions")
        .update({ scheduled_at: nowIso })
        .eq("instance", t.instance).eq("domain", t.domain).eq("status", "pending")
        .select("domain");
      moved += (data || []).length;
    }
    return moved;
  }
  const { data } = await supabase
    .from("duplicate_domain_deletions")
    .update({ scheduled_at: nowIso })
    .eq("status", "pending")
    .in("source", ["duplicate", "move"])
    .gt("scheduled_at", nowIso)
    .select("domain");
  return (data || []).length;
}

export async function cancelDeletion(instance: string, domain: string): Promise<void> {
  await getSupabaseAdmin().from("duplicate_domain_deletions").delete().eq("instance", instance).eq("domain", domain);
}
