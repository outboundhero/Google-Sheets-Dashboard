// Persistence for the segmented threshold groups. Singleton row (id = 1) in the
// new `replacement_threshold_config` table — kept separate from the flat
// `replacement_settings` so the existing guardrails are untouched. Server-only.
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  defaultThresholdConfig,
  type ThresholdConfig,
  type ThresholdSegment,
} from "./threshold-groups";

export async function getThresholdConfig(): Promise<ThresholdConfig> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("replacement_threshold_config")
    .select("*")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  // No row yet → hand back Spencer's default seed (staged, enabled:false) so the
  // UI shows the cleaning defaults ready to review + save + turn on.
  if (!data) return defaultThresholdConfig();
  // Segments saved before the "domain name has / never" fields existed get the
  // seeded words — the ones domain-inventory and the plan already fall back
  // to — so the editor shows the words in force and a save keeps them instead
  // of writing back the empty boxes it used to display.
  const seed = new Map(defaultThresholdConfig().segments.map((sg) => [sg.id, sg]));
  const segments = ((data.segments as ThresholdSegment[] | null) ?? []).map((sg) => {
    const fill = seed.get(sg.id);
    return fill && sg.keywordsInclude === undefined && sg.keywordsExclude === undefined
      ? { ...sg, keywordsInclude: fill.keywordsInclude ?? [], keywordsExclude: fill.keywordsExclude ?? [] }
      : sg;
  });
  return {
    enabled: Boolean(data.enabled),
    segments,
    updatedAt: data.updated_at ?? undefined,
  };
}

export async function updateThresholdConfig(
  patch: Partial<Pick<ThresholdConfig, "enabled" | "segments">>,
): Promise<ThresholdConfig> {
  const supabase = getSupabaseAdmin();
  const row: Record<string, unknown> = { id: 1, updated_at: new Date().toISOString() };
  if (patch.enabled !== undefined) row.enabled = patch.enabled;
  if (patch.segments !== undefined) row.segments = patch.segments;
  const { error } = await supabase
    .from("replacement_threshold_config")
    .upsert(row, { onConflict: "id" });
  if (error) throw new Error(error.message);
  return getThresholdConfig();
}
