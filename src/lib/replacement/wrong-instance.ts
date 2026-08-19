// Wrong-instance detector (Nick #3, 2026-08-05). Each client tag is ALLOCATED to
// a Bison group (1 or 2) in the allocation sheet; any of its domains sitting on
// an instance in the OTHER group is "on the wrong instance." This flags those
// clients and, per misplaced domain, computes the correct target instance (same
// tier — b2b/b2c — but in the allocated group) so the /replacement "Run" button
// can move them there via the existing Inboxing move flow. READ-ONLY: detection
// changes nothing. Unallocated tags (not in the sheet) are skipped — we can't
// know their correct group, so they show in both groups by design.
import { getSupabaseAdmin } from "@/lib/supabase";
import { getAllocations } from "@/lib/client-tag-allocations";
import { getKnownClientTags } from "./cross-tag-audit";
import { getHiddenTagSet } from "./tag-skips";
import { inboxingConnectionFor } from "./inboxing-connections";
import {
  ALL_INSTANCE_SLUGS, getInstance, INSTANCE_SHORT_LABELS,
  type BisonInstanceSlug, type BisonGroup, type BisonTier,
} from "@/lib/bison-instances";

const hasInboxingTag = (tags: string[]) =>
  tags.some((t) => (t || "").trim().toLowerCase().startsWith("inboxing"));

/** One source→target hop for a flagged client (same tier, allocated group). */
export interface WrongMoveGroup {
  sourceInstance: BisonInstanceSlug;
  sourceLabel: string;
  targetInstance: BisonInstanceSlug;
  targetLabel: string;
  tier: BisonTier;
  platformConnectionId: string;      // Inboxing connection wired to the target instance
  domains: string[];                 // all misplaced domains on this source
  inboxingDomains: string[];         // auto-movable via the Inboxing upload flow
  otherDomains: string[];            // no Inboxing tag → need a manual move
  inboxCount: number;
}
export interface WrongFlaggedClient {
  clientTag: string;
  allocatedGroup: BisonGroup;
  misplacedDomains: number;
  inboxingDomains: number;           // total auto-movable across groups
  inboxCount: number;
  groups: WrongMoveGroup[];
  /** Hidden by an operator — still computed, filed separately by the card. */
  hidden?: boolean;
}
export interface WrongInstanceResult {
  checkedAt: string;
  clientsFlagged: number;            // excludes hidden clients
  domainsMisplaced: number;          // excludes hidden clients
  flagged: WrongFlaggedClient[];     // includes hidden ones, marked
  hiddenCount: number;
}

/** The instance in `group` with the given tier (b2b/b2c), or null if none. */
function instanceFor(group: BisonGroup, tier: BisonTier): BisonInstanceSlug | null {
  for (const slug of ALL_INSTANCE_SLUGS) {
    const inst = getInstance(slug);
    if (inst.group === group && inst.tier === tier) return slug;
  }
  return null;
}

export async function detectWrongInstance(): Promise<WrongInstanceResult> {
  const [{ map: allocation }, knownTags] = await Promise.all([getAllocations(), getKnownClientTags()]);
  const supabase = getSupabaseAdmin();

  // clientTag → sourceInstance → bucket of its misplaced domains
  interface Bucket { domains: string[]; inboxing: string[]; other: string[]; inboxCount: number }
  const byClient = new Map<string, Map<BisonInstanceSlug, Bucket>>();

  let off = 0;
  while (true) {
    const { data } = await supabase
      .from("deliverability_domains")
      .select("instance,domain,tags,inbox_count")
      .in("instance", ALL_INSTANCE_SLUGS)
      .range(off, off + 999);
    if (!data || data.length === 0) break;
    for (const r of data as { instance: BisonInstanceSlug; domain: string; tags: unknown; inbox_count: number | null }[]) {
      let tags: unknown = r.tags;
      if (typeof tags === "string") { try { tags = JSON.parse(tags); } catch { tags = []; } }
      const names = ((tags as unknown[]) || [])
        .map((t) => String(t && typeof t === "object" ? (t as { name?: string }).name : t).trim())
        .filter(Boolean);
      // The domain's client = first tag that's both a real client tag AND allocated.
      const clientTag = names.find((n) => knownTags.has(n) && allocation[n.toUpperCase()] != null);
      if (!clientTag) continue;
      const group = allocation[clientTag.toUpperCase()];
      if (getInstance(r.instance).group === group) continue;   // correctly placed → skip
      let m = byClient.get(clientTag);
      if (!m) { m = new Map(); byClient.set(clientTag, m); }
      let b = m.get(r.instance);
      if (!b) { b = { domains: [], inboxing: [], other: [], inboxCount: 0 }; m.set(r.instance, b); }
      b.domains.push(r.domain);
      (hasInboxingTag(names) ? b.inboxing : b.other).push(r.domain);
      b.inboxCount += r.inbox_count || 0;
    }
    if (data.length < 1000) break;
    off += 1000;
  }

  const flagged: WrongFlaggedClient[] = [];
  for (const [clientTag, bySource] of byClient) {
    const group = allocation[clientTag.toUpperCase()];
    const groups: WrongMoveGroup[] = [];
    for (const [sourceInstance, b] of bySource) {
      const tier = getInstance(sourceInstance).tier;
      const targetInstance = instanceFor(group, tier);
      if (!targetInstance) continue;               // no same-tier instance in the target group
      groups.push({
        sourceInstance, sourceLabel: INSTANCE_SHORT_LABELS[sourceInstance],
        targetInstance, targetLabel: INSTANCE_SHORT_LABELS[targetInstance],
        tier, platformConnectionId: inboxingConnectionFor(targetInstance),
        domains: [...b.domains].sort(), inboxingDomains: [...b.inboxing].sort(),
        otherDomains: [...b.other].sort(), inboxCount: b.inboxCount,
      });
    }
    if (groups.length === 0) continue;
    groups.sort((a, z) => a.sourceLabel.localeCompare(z.sourceLabel));
    flagged.push({
      clientTag, allocatedGroup: group,
      misplacedDomains: groups.reduce((s, g) => s + g.domains.length, 0),
      inboxingDomains: groups.reduce((s, g) => s + g.inboxingDomains.length, 0),
      inboxCount: groups.reduce((s, g) => s + g.inboxCount, 0),
      groups,
    });
  }
  flagged.sort((a, z) => z.misplacedDomains - a.misplacedDomains || a.clientTag.localeCompare(z.clientTag));

  // Hidden tags stay in `flagged` (so the card can offer them back) but are
  // left out of the headline counts — that's the point of hiding them.
  const hiddenTags = await getHiddenTagSet();
  for (const c of flagged) {
    if (hiddenTags.has(c.clientTag.trim().toUpperCase())) c.hidden = true;
  }
  const visible = flagged.filter((c) => !c.hidden);

  return {
    checkedAt: new Date().toISOString(),
    clientsFlagged: visible.length,
    domainsMisplaced: visible.reduce((s, c) => s + c.misplacedDomains, 0),
    flagged,
    hiddenCount: flagged.length - visible.length,
  };
}
