// Bison sender-account capacity per instance — editable from the dashboard
// (table `bison_capacity`), so nobody touches env vars when Ahmad bumps a
// workspace limit. Env `BISON_SENDER_CAPACITY_<SLUG>` remains a fallback;
// 0/unknown = no limit known → the capacity gate skips that instance.
import { getSupabaseAdmin } from "@/lib/supabase";
import { ALL_INSTANCE_SLUGS } from "@/lib/bison-instances";

export interface CapacityRow {
  instance: string;
  maxSenders: number;   // 0 = unknown → gate off for this instance
  currentSenders: number;
}

function envFor(instance: string): number {
  return Math.max(0, Number(process.env[`BISON_SENDER_CAPACITY_${instance.toUpperCase()}`] ?? 0));
}

/** Limits per instance: DB first, env fallback. Never throws (missing table → env). */
export async function getCapacityLimits(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const s of ALL_INSTANCE_SLUGS) out[s] = envFor(s);
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.from("bison_capacity").select("instance,max_senders");
    if (!error) {
      for (const r of data || []) {
        if (Number(r.max_senders) > 0) out[r.instance as string] = Number(r.max_senders);
      }
    }
  } catch { /* table not created yet → env fallback */ }
  return out;
}

/** Limits + live sender counts, for the editor card. */
export async function getCapacityStatus(): Promise<CapacityRow[]> {
  const supabase = getSupabaseAdmin();
  const limits = await getCapacityLimits();
  const rows: CapacityRow[] = [];
  for (const instance of ALL_INSTANCE_SLUGS) {
    const { count } = await supabase
      .from("deliverability_inboxes")
      .select("id", { count: "exact", head: true })
      .eq("instance", instance);
    rows.push({ instance, maxSenders: limits[instance] ?? 0, currentSenders: count ?? 0 });
  }
  return rows;
}

export async function setCapacityLimits(values: Record<string, number>): Promise<void> {
  const supabase = getSupabaseAdmin();
  const rows = ALL_INSTANCE_SLUGS
    .filter((s) => values[s] !== undefined)
    .map((s) => ({ instance: s, max_senders: Math.max(0, Math.floor(Number(values[s]) || 0)), updated_at: new Date().toISOString() }));
  if (rows.length === 0) return;
  const { error } = await supabase.from("bison_capacity").upsert(rows, { onConflict: "instance" });
  if (error) throw new Error(error.message);
}
