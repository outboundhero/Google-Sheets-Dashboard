// Archived Main / Nurture campaigns on clients that are still active.
//
// Spencer 2026-10-07 (SINY): an active client's B2C #2 "Google + Custom" and
// "SEGs" sat archived for two weeks and nothing said so. Completed campaigns
// are revived by the revive-completed cron; archived ones are a human call
// (unarchive, or confirm it was on purpose), so this only FLAGS them.
//
// A campaign is flagged when all of these hold:
//   • its client is Active in the Client Tracker and has not reached its
//     churn date
//   • it is one of the standard three in a set (Google + Custom / Outlook /
//     SEGs) — deriveSetRole
//   • the same stage on the same instance is still in use (at least one of
//     its campaigns is not archived), so this is a hole in a running set,
//     not an old set someone retired on purpose
//   • no other, non-archived campaign covers that role in that stage
//   • the instance is in the client's allocated group (allocation sheet).
//     A client moved to the other group leaves its old instance's
//     campaigns archived on purpose — 7 of the first 11 flags (Oct 9) were
//     exactly that. Unallocated clients are checked everywhere.
//   • Bison still reports it archived right now (the mirror is up to 6 h old;
//     SINY was revived by hand before this ran for the first time)
// When several archived campaigns cover the same missing role, only the
// newest is reported.
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import { getInstance, isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";
import { getAllocations } from "@/lib/client-tag-allocations";
import { getClientTierMap, resolveTier } from "@/lib/cron/client-reports";
import { getChurnBlackoutMap } from "@/lib/replacement/churn-guard";
import { deriveSetRole, deriveStage, setRoleLabel } from "./stage";

export interface ArchivedCampaign {
  id: number;
  name: string;
  stage: string;
  role: string;
  /** false when the live re-check could not reach Bison — reported anyway. */
  verified: boolean;
}

export interface ArchivedFinding {
  clientTag: string;
  instance: BisonInstanceSlug;
  campaigns: ArchivedCampaign[];
}

export interface ArchivedCheckResult {
  findings: ArchivedFinding[];
  /** Mirror said archived, Bison says otherwise now (revived since the sync). */
  alreadyRevived: { clientTag: string; instance: string; id: number; name: string; status: string }[];
  clientsChecked: number;
}

interface CampaignRow { instance: string; id: number; name: string; status: string | null; client_tag: string | null }

async function liveStatus(instance: BisonInstanceSlug, id: number): Promise<string | null> {
  try {
    const res = await bisonFetch(instance, `/campaigns/${id}`);
    if (!res.ok) return null;
    const json = await res.json();
    const c = (Array.isArray(json) ? json[0] : json)?.data ?? json;
    return typeof c?.status === "string" ? c.status.toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function findArchivedCampaigns(): Promise<ArchivedCheckResult> {
  const supabase = getSupabaseAdmin();
  const rows: CampaignRow[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await supabase
      .from("campaigns")
      .select("instance, id, name, status, client_tag")
      .order("id")
      .range(off, off + 999);
    if (error) throw new Error(`campaigns read: ${error.message}`);
    rows.push(...((data || []) as CampaignRow[]));
    if (!data || data.length < 1000) break;
  }

  const [tiers, churn, { map: alloc }] = await Promise.all([getClientTierMap(), getChurnBlackoutMap(), getAllocations()]);

  const byKey = new Map<string, CampaignRow[]>();
  for (const r of rows) {
    if (!r.client_tag || !isInstanceSlug(r.instance)) continue;
    const k = `${r.client_tag.trim().toUpperCase()}|${r.instance}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(r);
  }

  const candidates: { clientTag: string; instance: BisonInstanceSlug; campaign: ArchivedCampaign }[] = [];
  const activeClients = new Set<string>();
  for (const [k, list] of byKey) {
    const [clientTag, instance] = k.split("|") as [string, BisonInstanceSlug];
    const tracker = resolveTier(clientTag, tiers);
    if (!tracker || !/active/i.test(tracker.status)) continue;
    const c = churn.get(clientTag);
    if (c?.daysUntil != null && c.daysUntil <= 0) continue;
    activeClients.add(clientTag);
    const group = alloc[clientTag];
    if (group != null && getInstance(instance).group !== group) continue;

    // stage → roles still covered by a non-archived campaign
    const liveRoles = new Map<string, Set<string>>();
    const archived = new Map<string, CampaignRow>(); // `${stage}|${role}` → newest archived
    for (const r of list) {
      const role = deriveSetRole(r.name);
      if (!role) continue;
      const stage = deriveStage(r.name);
      if (String(r.status || "").toLowerCase() === "archived") {
        const key = `${stage}|${role}`;
        const prev = archived.get(key);
        if (!prev || r.id > prev.id) archived.set(key, r);
      } else {
        if (!liveRoles.has(stage)) liveRoles.set(stage, new Set());
        liveRoles.get(stage)!.add(role);
      }
    }
    for (const [key, r] of archived) {
      const [stage, role] = key.split("|");
      const live = liveRoles.get(stage);
      if (!live || live.size === 0) continue; // whole stage retired — not a hole
      if (live.has(role)) continue;           // another campaign covers it
      candidates.push({
        clientTag, instance,
        campaign: { id: r.id, name: r.name, stage, role: setRoleLabel(role), verified: false },
      });
    }
  }

  // Live re-check — the mirror lags Bison by up to 6 hours.
  const alreadyRevived: ArchivedCheckResult["alreadyRevived"] = [];
  const byFinding = new Map<string, ArchivedFinding>();
  for (const cand of candidates) {
    const status = await liveStatus(cand.instance, cand.campaign.id);
    if (status !== null && status !== "archived") {
      alreadyRevived.push({ clientTag: cand.clientTag, instance: cand.instance, id: cand.campaign.id, name: cand.campaign.name, status });
      continue;
    }
    const k = `${cand.clientTag}|${cand.instance}`;
    if (!byFinding.has(k)) byFinding.set(k, { clientTag: cand.clientTag, instance: cand.instance, campaigns: [] });
    byFinding.get(k)!.campaigns.push({ ...cand.campaign, verified: status === "archived" });
  }

  const findings = [...byFinding.values()].sort((a, b) => a.clientTag.localeCompare(b.clientTag) || a.instance.localeCompare(b.instance));
  return { findings, alreadyRevived, clientsChecked: activeClients.size };
}
