import { getSupabaseAdmin } from "@/lib/supabase";
import { pstDateString } from "@/lib/date-utils";
import { ALL_INSTANCE_SLUGS, type BisonInstanceSlug } from "@/lib/bison-instances";

/**
 * Daily per-domain snapshot of the cumulative Bison counters.
 *
 * Bison only exposes LIFETIME totals per sender email (emails_sent_count,
 * total_replied_count, bounced_count), which `rebuild_domain_stats` rolls up
 * into deliverability_domains.{total_sent,total_replied,total_bounced}. To get
 * a *trailing* window (last 10 / 15 days) we record those cumulative totals
 * once per day, then diff today's value against the snapshot N days ago:
 *
 *   reply rate (last N days) = (replied_today − replied_{N days ago})
 *                            ÷ (sent_today − sent_{N days ago})
 *
 * Snapshots are keyed by (instance, domain, snapshot_date) so re-running on the
 * same PST day is idempotent (it overwrites that day's row).
 *
 * NOTE: the underlying Bison crawl refreshes these totals roughly every 2 days
 * (see vercel.json deliverability crons), so trailing rates have ~2-day
 * granularity — accurate over a 10/15-day window, not to the hour.
 */

export interface SnapshotResult {
  instance: BisonInstanceSlug;
  snapshotDate: string;
  domains: number;
}

interface SnapshotRow {
  instance: BisonInstanceSlug;
  domain: string;
  snapshot_date: string;
  total_sent: number;
  total_replied: number;
  total_bounced: number;
}

export async function snapshotDeliverabilityInstance(
  instance: BisonInstanceSlug,
): Promise<SnapshotResult> {
  const supabase = getSupabaseAdmin();
  const snapshotDate = pstDateString(new Date());

  const PAGE = 1000;
  const rows: SnapshotRow[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("deliverability_domains")
      .select("domain, total_sent, total_replied, total_bounced")
      .eq("instance", instance)
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const d of data) {
      rows.push({
        instance,
        domain: d.domain as string,
        snapshot_date: snapshotDate,
        total_sent: (d.total_sent as number) ?? 0,
        total_replied: (d.total_replied as number) ?? 0,
        total_bounced: (d.total_bounced as number) ?? 0,
      });
    }
    if (data.length < PAGE) break;
    offset += PAGE;
  }

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase
      .from("deliverability_domain_snapshots")
      .upsert(rows.slice(i, i + 500), { onConflict: "instance,domain,snapshot_date" });
    if (error) throw new Error(error.message);
  }

  return { instance, snapshotDate, domains: rows.length };
}

export async function snapshotAllInstances(): Promise<SnapshotResult[]> {
  const results: SnapshotResult[] = [];
  for (const instance of ALL_INSTANCE_SLUGS) {
    results.push(await snapshotDeliverabilityInstance(instance));
  }
  return results;
}
