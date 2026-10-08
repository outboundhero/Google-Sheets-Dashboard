// "Waiting sides" — an instance where a LIVE client has its campaigns built but
// not sending yet, most often because it has no domains there to send from.
//
// Spencer 2026-10-08: 23 active Group 1 clients had 20 domains in B2B1 and
// zero in B2C1, with their B2C1 campaigns sitting in draft. Since Nick's
// 2026-09-22 rule ("a client that has not launched must not be filled — its
// initial domains are added by hand", after CGCWP got 25 domains nobody asked
// for) the true-up skipped every (client, instance) without a sending
// campaign, and the buy list didn't count them either. A client that has not
// launched ANYWHERE is still skipped; a client already sending on its other
// instance is not new — its B2C side is just waiting for stock.
//
// A `${TAG}:${instance}` is a waiting side when all hold:
//   • the client is Active in the Client Tracker and not in its churn blackout
//   • the instance belongs to the client's allocated group (allocation sheet);
//     unallocated clients are never guessed at
//   • the client has an eligible campaign there (draft / paused / active /
//     launching — the same set the attach step targets)
//   • nothing is actively sending for it there yet
//   • it IS actively sending on some other instance
// Filling a waiting side only tags, redirects and attaches — attaching never
// changes a campaign's status, so nothing is launched.
import { getSupabaseAdmin } from "@/lib/supabase";
import { ALL_INSTANCE_SLUGS, getInstance, isInstanceSlug } from "@/lib/bison-instances";
import { getClientTierMap, resolveTier } from "@/lib/cron/client-reports";
import { getAllocations } from "@/lib/client-tag-allocations";
import { getChurnBlackoutMap } from "./churn-guard";
import { isEligibleStatus, PURCHASE_ACTIVE_STATUSES, normStatus } from "./campaigns";

/** `exclude`: tags the true-up never fills (its INTERNAL_TAGS), so buying and
 *  filling count the same clients. */
export async function getWaitingSideKeys(opts: { exclude?: Set<string> } = {}): Promise<Set<string>> {
  const supabase = getSupabaseAdmin();
  const eligible = new Set<string>();
  const sending = new Set<string>();
  const sendingTags = new Set<string>();
  for (let off = 0; ; off += 1000) {
    const { data, error } = await supabase
      .from("campaigns")
      .select("instance, status, client_tag")
      .in("instance", ALL_INSTANCE_SLUGS)
      .order("id")
      .range(off, off + 999);
    if (error) throw new Error(error.message);
    for (const r of (data || []) as { instance: string; status: string | null; client_tag: string | null }[]) {
      if (!r.client_tag || !isInstanceSlug(r.instance)) continue;
      const key = `${r.client_tag.trim().toUpperCase()}:${r.instance}`;
      if (isEligibleStatus(r.status)) eligible.add(key);
      if (PURCHASE_ACTIVE_STATUSES.has(normStatus(r.status))) {
        sending.add(key);
        sendingTags.add(r.client_tag.trim().toUpperCase());
      }
    }
    if (!data || data.length < 1000) break;
  }

  const [tiers, { map: alloc }, churn] = await Promise.all([
    getClientTierMap(),
    getAllocations(),
    getChurnBlackoutMap(),
  ]);

  const out = new Set<string>();
  for (const key of eligible) {
    if (sending.has(key)) continue;
    const sep = key.lastIndexOf(":");
    const tag = key.slice(0, sep);
    const instance = key.slice(sep + 1);
    if (!sendingTags.has(tag) || !isInstanceSlug(instance)) continue;
    if (opts.exclude?.has(tag)) continue;
    const tracker = resolveTier(tag, tiers);
    if (!tracker || !/active/i.test(tracker.status)) continue;
    if (churn.get(tag)?.blocked) continue;
    const group = alloc[tag];
    if (group == null || getInstance(instance).group !== group) continue;
    out.add(key);
  }
  return out;
}
