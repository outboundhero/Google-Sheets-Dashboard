// Cross-tag campaign audit — finds domains whose inboxes are attached to
// campaigns belonging to a DIFFERENT client (campaign client_tag != domain's
// own tag). This is the cross-client contamination Spencer wants surfaced on
// the dashboard so it can be selectively cleaned up.
//
// Membership isn't stored anywhere, so we sample a few inboxes per domain and
// ask Bison which campaigns each is in (the same per-inbox lookup the
// remove-from-campaigns flow uses). A domain's inboxes are attached uniformly,
// so a small sample reliably reveals the campaign set. The audit is chunked
// (the FE drives it a batch of domains at a time) so it never times out.
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import { ALL_INSTANCE_SLUGS, type BisonInstanceSlug } from "@/lib/bison-instances";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clientTagOf = (name: string) => (name.split(":")[0] || "").trim();

const SAMPLE_PER_DOMAIN = 8;   // inboxes sampled per domain to reveal its campaigns
const INBOX_CONC = 8;          // concurrent per-inbox lookups

export interface WrongCampaign { id: number; name: string; status: string; clientTag: string; instance: string }
export interface FlaggedDomain { instance: string; domain: string; clientTag: string; wrongCampaigns: WrongCampaign[] }
export interface DomainRef { instance: BisonInstanceSlug; domain: string }

/** Distinct client tags that actually exist as campaign name prefixes. */
export async function getKnownClientTags(): Promise<Set<string>> {
  const supabase = getSupabaseAdmin();
  const tags = new Set<string>();
  let off = 0;
  while (true) {
    const { data } = await supabase.from("campaigns").select("client_tag").not("client_tag", "is", null).range(off, off + 999);
    if (!data || data.length === 0) break;
    for (const r of data) if (r.client_tag) tags.add(String(r.client_tag).trim());
    if (data.length < 1000) break;
    off += 1000;
  }
  tags.delete("");
  return tags;
}

/** Every assigned (instance, domain) to audit. */
export async function getAssignedDomains(): Promise<DomainRef[]> {
  const supabase = getSupabaseAdmin();
  const out: DomainRef[] = [];
  let off = 0;
  while (true) {
    const { data } = await supabase.from("deliverability_domains").select("instance,domain").in("instance", ALL_INSTANCE_SLUGS).range(off, off + 999);
    if (!data || data.length === 0) break;
    for (const r of data) out.push({ instance: r.instance as BisonInstanceSlug, domain: r.domain });
    if (data.length < 1000) break;
    off += 1000;
  }
  return out;
}

/** Pick up to n items evenly spread across the array (catches different inbox
 *  types, which map to different campaigns). */
function sampleEvenly<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const out: T[] = [];
  const step = arr.length / n;
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

/** Campaigns one inbox is attached to (paginated, transient-retry). */
async function inboxCampaigns(instance: BisonInstanceSlug, inboxId: number): Promise<{ id: number; name: string; status: string }[]> {
  const out: { id: number; name: string; status: string }[] = [];
  let page = 1;
  while (true) {
    let json: { data?: { id: number; name: string; status: string }[]; meta?: { last_page?: number } } | null = null;
    for (let a = 0; a < 5; a++) {
      const res = await bisonFetch(instance, `/sender-emails/${inboxId}/campaigns?page=${page}&per_page=100`);
      if (res.status === 404) { json = { data: [] }; break; }
      if (res.ok) { try { json = await res.json(); break; } catch { /* retry */ } }
      const ra = parseInt(res.headers.get("retry-after") || "", 10);
      await delay((Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(8000, 500 * 2 ** a)) + Math.floor(Math.random() * 200));
    }
    if (!json) break;
    for (const c of json.data || []) out.push({ id: c.id, name: c.name, status: c.status });
    if (page >= (json.meta?.last_page || 1)) break;
    page++;
  }
  return out;
}

async function pool<T>(items: T[], conc: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (true) { const i = next++; if (i >= items.length) return; await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, () => worker()));
}

/** Audit a batch of domains. Returns the ones with wrong-tag campaign memberships. */
export async function auditDomainsBatch(rows: DomainRef[], knownTags: Set<string>): Promise<FlaggedDomain[]> {
  const supabase = getSupabaseAdmin();
  const flagged: FlaggedDomain[] = [];

  for (const { instance, domain } of rows) {
    // The domain's own client tag(s).
    const { data: domRows } = await supabase.from("deliverability_domains").select("tags").eq("instance", instance).eq("domain", domain).limit(1);
    let tags: unknown = domRows?.[0]?.tags;
    if (typeof tags === "string") { try { tags = JSON.parse(tags); } catch { tags = []; } }
    const domTags = new Set(
      ((tags as unknown[]) || [])
        .map((t) => String(t && typeof t === "object" ? (t as { name?: string }).name : t).trim())
        .filter((t) => knownTags.has(t)),
    );
    if (domTags.size === 0) continue;            // reserve / unassigned — nothing to audit
    const ownTag = [...domTags][0];

    // Sample inboxes → union of campaigns they're in.
    const { data: inb } = await supabase.from("deliverability_inboxes").select("id").eq("instance", instance).eq("domain", domain).limit(80);
    const ids = (inb || []).map((r) => r.id as number);
    if (ids.length === 0) continue;
    const sample = sampleEvenly(ids, SAMPLE_PER_DOMAIN);

    const campMap = new Map<number, { name: string; status: string }>();
    await pool(sample, INBOX_CONC, async (id) => {
      for (const c of await inboxCampaigns(instance, id)) campMap.set(c.id, { name: c.name, status: c.status });
    });

    // Campaigns whose client tag isn't one of the domain's tags = wrong.
    const wrong: WrongCampaign[] = [];
    for (const [id, c] of campMap) {
      const ct = clientTagOf(c.name);
      if (ct && knownTags.has(ct) && !domTags.has(ct)) {
        wrong.push({ id, name: c.name, status: c.status, clientTag: ct, instance });
      }
    }
    if (wrong.length > 0) {
      wrong.sort((a, b) => a.name.localeCompare(b.name));
      flagged.push({ instance, domain, clientTag: ownTag, wrongCampaigns: wrong });
    }
  }
  return flagged;
}

// ── Storage ────────────────────────────────────────────────────────────────
export async function clearAudit(): Promise<void> {
  await getSupabaseAdmin().from("cross_tag_audit").delete().neq("domain", "");
}

export async function storeFlagged(flagged: FlaggedDomain[]): Promise<void> {
  if (flagged.length === 0) return;
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("cross_tag_audit").upsert(
    flagged.map((f) => ({ instance: f.instance, domain: f.domain, client_tag: f.clientTag, wrong_campaigns: f.wrongCampaigns, audited_at: new Date().toISOString() })),
    { onConflict: "instance,domain" },
  );
  if (error) throw new Error(error.message);
}

export async function getFlagged(): Promise<FlaggedDomain[]> {
  const supabase = getSupabaseAdmin();
  const out: FlaggedDomain[] = [];
  let off = 0;
  while (true) {
    const { data } = await supabase.from("cross_tag_audit").select("instance,domain,client_tag,wrong_campaigns").range(off, off + 999);
    if (!data || data.length === 0) break;
    for (const r of data) out.push({ instance: r.instance, domain: r.domain, clientTag: r.client_tag, wrongCampaigns: (r.wrong_campaigns as WrongCampaign[]) || [] });
    if (data.length < 1000) break;
    off += 1000;
  }
  out.sort((a, b) => a.clientTag.localeCompare(b.clientTag) || a.domain.localeCompare(b.domain));
  return out;
}

/** Drop a domain's row once it's been cleaned (no wrong campaigns left). */
export async function clearDomain(instance: string, domain: string): Promise<void> {
  await getSupabaseAdmin().from("cross_tag_audit").delete().eq("instance", instance).eq("domain", domain);
}
