import { Redis } from "@upstash/redis";
import { getSupabaseAdmin } from "@/lib/supabase";
import { isInstanceSlug } from "@/lib/bison-instances";
import { duplicateOne, logCampaignEvent } from "@/lib/campaigns/duplication";
import { recordPipelineAlert } from "@/lib/pipeline-alerts";

// Drains the shared duplication queue — ONE client-tag set per call, strictly
// sequential, protected by a cluster-wide single-flight lock so the FE loop and
// the cron backstop can never run two sets at once (mixing campaign order). A
// failure inside a set fails that item, BLOCKS the rest of the set, alerts, and
// stops; the next call picks the next eligible set.

const LOCK_KEY = "campaign-dup-drain:lock";
const BUDGET_MS = 45_000;
const ITEM_CAP = 12;

interface Row { id: number; job_id: string; instance: string; client_tag: string; source_id: number; source_name: string; set_role: string | null; order_index: number; status: string }

function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function drainDuplicationOnce(): Promise<{ processed: number; remaining: number; more: boolean; locked?: boolean }> {
  const t0 = Date.now();
  const redis = getRedis();
  if (redis) {
    const got = await redis.set(LOCK_KEY, "1", { nx: true, ex: 90 });
    if (!got) return { locked: true, processed: 0, remaining: -1, more: true };
  }
  const supabase = getSupabaseAdmin();
  let processed = 0;
  try {
    const { data } = await supabase
      .from("campaign_dup_queue").select("*")
      .in("status", ["queued", "duplicating", "blocked", "failed"])
      .order("submitted_at", { ascending: true })
      .order("client_tag", { ascending: true })
      .order("order_index", { ascending: true });
    const rows = (data || []) as Row[];

    // First set with a queued item and no failed/blocked/duplicating item.
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const k = `${r.job_id}|${r.instance}|${r.client_tag}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }
    let target: Row[] | null = null;
    for (const g of groups.values()) {
      if (g.some((r) => r.status === "queued") && !g.some((r) => r.status === "failed" || r.status === "blocked" || r.status === "duplicating")) { target = g; break; }
    }

    if (target) {
      const queued = target.filter((r) => r.status === "queued").sort((a, b) => a.order_index - b.order_index);
      for (const item of queued) {
        if (Date.now() - t0 > BUDGET_MS || processed >= ITEM_CAP) break;
        if (!isInstanceSlug(item.instance)) continue;
        const stamp = () => new Date().toISOString();
        await supabase.from("campaign_dup_queue").update({ status: "duplicating", updated_at: stamp() }).eq("id", item.id);
        const res = await duplicateOne(item.instance, item.source_id);
        if (res.ok) {
          await supabase.from("campaign_dup_queue").update({ status: "done", new_id: res.newId ?? null, new_name: res.newName ?? null, error: null, updated_at: stamp() }).eq("id", item.id);
          await logCampaignEvent(supabase, { instance: item.instance, campaignId: res.newId ?? null, clientTag: item.client_tag, eventType: "duplicated", detail: `Duplicated "${item.source_name}" → ${res.newName ?? res.newId}`, meta: { sourceId: item.source_id, jobId: item.job_id } });
          processed++;
        } else {
          await supabase.from("campaign_dup_queue").update({ status: "failed", error: res.error ?? "duplicate failed", updated_at: stamp() }).eq("id", item.id);
          await supabase.from("campaign_dup_queue").update({ status: "blocked", updated_at: stamp() }).eq("job_id", item.job_id).eq("instance", item.instance).eq("client_tag", item.client_tag).eq("status", "queued");
          await logCampaignEvent(supabase, { instance: item.instance, clientTag: item.client_tag, eventType: "duplicate_failed", detail: `"${item.source_name}" failed: ${res.error ?? ""}`, meta: { sourceId: item.source_id, jobId: item.job_id } });
          await recordPipelineAlert({ source: "campaigns-dup", clientTag: item.client_tag, step: "duplicate", reason: `Duplication failed for "${item.source_name}": ${res.error ?? "unknown"}` });
          break;
        }
      }
    }

    const { count } = await supabase.from("campaign_dup_queue").select("id", { count: "exact", head: true }).eq("status", "queued");
    const remaining = count ?? 0;
    return { processed, remaining, more: remaining > 0 };
  } finally {
    if (redis) await redis.del(LOCK_KEY);
  }
}
