// Duplicate-domain detection across the 4 Bison instances. The same domain
// living in more than one instance means overlapping infrastructure; Spencer
// wants to pick which instance to strip it from (remove senders from campaigns
// now, delete from that instance after a 4-day grace). Detection is a cheap
// read of deliverability_domains (one row per instance,domain, with inbox_count).
import { getSupabaseAdmin } from "@/lib/supabase";
import { ALL_INSTANCE_SLUGS } from "@/lib/bison-instances";

export const DUP_GRACE_DAYS = 4;

export interface DupInstance {
  instance: string;
  inboxes: number;
  tags: string[];
  createdAt: string | null; // domain_created_at ISO, or null
}
export interface DuplicateDomain { domain: string; instances: DupInstance[] }

/** Domains present in 2+ instances, with per-instance inbox counts, tags, and created date. */
export async function getDuplicateDomains(): Promise<DuplicateDomain[]> {
  const supabase = getSupabaseAdmin();
  const map = new Map<string, DupInstance[]>();
  let off = 0;
  while (true) {
    const { data } = await supabase
      .from("deliverability_domains")
      .select("instance,domain,inbox_count,tags,domain_created_at")
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

export async function scheduleDeletions(entries: { instance: string; domain: string }[], graceDays = DUP_GRACE_DAYS): Promise<void> {
  if (entries.length === 0) return;
  const supabase = getSupabaseAdmin();
  const at = new Date(Date.now() + graceDays * 86400000).toISOString();
  const { error } = await supabase.from("duplicate_domain_deletions").upsert(
    entries.map((e) => ({ instance: e.instance, domain: e.domain, scheduled_at: at, status: "pending" })),
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
    .order("scheduled_at");
  return (data || []).map((r) => ({ instance: r.instance, domain: r.domain, scheduledAt: r.scheduled_at, status: r.status }));
}

export async function cancelDeletion(instance: string, domain: string): Promise<void> {
  await getSupabaseAdmin().from("duplicate_domain_deletions").delete().eq("instance", instance).eq("domain", domain);
}
