import { getConfig, resolveSpreadsheetId } from "@/lib/sheets-config";
import { getSupabaseAdmin } from "@/lib/supabase";

/**
 * Syncs tracked sheets config from Redis/JSON to Supabase.
 * Upserts all current sheets and removes orphaned rows.
 */
export async function syncSheetsToSupabase(): Promise<{ synced: number; removed: number }> {
  const config = await getConfig();
  const supabase = getSupabaseAdmin();

  // Upsert all current sheets. `id` is the composite (spreadsheet::tab) so two
  // tabs of one spreadsheet coexist; `spreadsheet_id` carries the raw id for
  // external consumers. (Requires the spreadsheet_id column — the whole mirror
  // is best-effort; callers .catch it, so a missing column can't break app UX.)
  const rows = config.sheets.map((s) => ({
    id: s.id,
    name: s.name,
    client_tag: s.clientTag,
    sheet_name: s.sheetName || "Leads",
    spreadsheet_id: resolveSpreadsheetId(s),
    added_at: s.addedAt,
    synced_at: new Date().toISOString(),
  }));

  let synced = 0;
  if (rows.length > 0) {
    const { error } = await supabase
      .from("tracked_sheets")
      .upsert(rows, { onConflict: "id", ignoreDuplicates: false });
    if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
    synced = rows.length;
  }

  // Remove sheets from Supabase that are no longer in config
  const currentIds = config.sheets.map((s) => s.id);
  const { data: existing } = await supabase
    .from("tracked_sheets")
    .select("id");

  const toRemove = (existing || [])
    .map((row) => row.id as string)
    .filter((id) => !currentIds.includes(id));

  let removed = 0;
  if (toRemove.length > 0) {
    await supabase.from("tracked_sheets").delete().in("id", toRemove);
    removed = toRemove.length;
  }

  return { synced, removed };
}
