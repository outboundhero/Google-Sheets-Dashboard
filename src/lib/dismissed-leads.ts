import { getSupabaseAdmin } from "@/lib/supabase";

const TABLE = "lead_not_received_dismissed";

function key(sheetId: string, leadEmail: string): string {
  return `${sheetId}::${leadEmail.toLowerCase()}`;
}

export async function listDismissedKeys(clientTag?: string): Promise<Set<string>> {
  const supabase = getSupabaseAdmin();
  let query = supabase.from(TABLE).select("sheet_id, lead_email");
  if (clientTag) query = query.eq("client_tag", clientTag);
  const { data, error } = await query;
  if (error) throw new Error(`Failed to read dismissed leads: ${error.message}`);
  const set = new Set<string>();
  for (const row of data || []) {
    set.add(key(row.sheet_id as string, row.lead_email as string));
  }
  return set;
}

export function dismissedKey(sheetId: string, leadEmail: string): string {
  return key(sheetId, leadEmail);
}

export async function dismissLead(input: {
  sheetId: string;
  leadEmail: string;
  clientTag: string;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from(TABLE)
    .upsert(
      {
        sheet_id: input.sheetId,
        lead_email: input.leadEmail.toLowerCase(),
        client_tag: input.clientTag,
        dismissed_at: new Date().toISOString(),
      },
      { onConflict: "sheet_id,lead_email", ignoreDuplicates: true },
    );
  if (error) throw new Error(`Failed to dismiss lead: ${error.message}`);
}
