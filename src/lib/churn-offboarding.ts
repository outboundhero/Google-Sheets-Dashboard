import { getSupabaseAdmin } from "@/lib/supabase";
import { getClientTrackerData, type ClientTrackerRow } from "@/lib/google-sheets";
import { getGroupForClientTag } from "@/lib/client-tag-allocations";
import { pstDateString } from "@/lib/date-utils";
import { executeClientOffboarding, type OffboardingResult } from "@/lib/client-offboarding";

export type OffboardingStatus = "pending" | "confirmed" | "skipped" | "auto_fired" | "failed";

export interface OffboardingActionRow {
  client_abbr: string;
  churn_date: string;             // YYYY-MM-DD
  status: OffboardingStatus;
  group_hint: 1 | 2 | null;
  decided_by: string | null;
  decided_at: string | null;
  executed_at: string | null;
  result: unknown;
  created_at: string;
}

// Sheet dates come through as FORMATTED_VALUE (e.g. "6/15/2026"). Normalize to
// YYYY-MM-DD for our `date` column. Returns null if unparseable.
export function parseSheetDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const d = new Date(trimmed);
  if (isNaN(d.getTime())) return null;
  // Use the date components as-is — the sheet's "6/15/2026" is local-noon in
  // most setups, so the UTC slice still yields 2026-06-15.
  return d.toISOString().slice(0, 10);
}

export interface ChurnedClient {
  clientAbbr: string;             // UPPERCASE — matches our table PK
  companyName: string;
  churnDate: string;              // YYYY-MM-DD
}

// Today's date, PST-anchored.
function todayPst(): string {
  return pstDateString(new Date());
}

// Rows in the sheet where Status === "Churned" and Churn Date <= today.
export async function findChurnedClients(rows?: ClientTrackerRow[]): Promise<ChurnedClient[]> {
  const data = rows ?? (await getClientTrackerData());
  const today = todayPst();
  const out: ChurnedClient[] = [];
  for (const row of data) {
    if (row.status?.trim().toLowerCase() !== "churned") continue;
    const date = parseSheetDate(row.churnDate);
    if (!date) continue;
    if (date > today) continue;  // future churn — wait for it
    const abbr = (row.clientAbbr || "").trim().toUpperCase();
    if (!abbr) continue;
    out.push({ clientAbbr: abbr, companyName: row.companyName || abbr, churnDate: date });
  }
  return out;
}

// For each churned client without an existing row in client_offboarding_actions,
// insert a new pending row. Preserves any prior decision (confirmed / skipped /
// auto_fired) — never overwrites.
export async function enqueuePendingOffboardings(): Promise<{
  scanned: number;
  created: number;
  alreadyTracked: number;
}> {
  const supabase = getSupabaseAdmin();
  const churned = await findChurnedClients();
  if (churned.length === 0) return { scanned: 0, created: 0, alreadyTracked: 0 };

  // Look up which (abbr, date) pairs we already have rows for.
  const abbrs = churned.map((c) => c.clientAbbr);
  const dates = churned.map((c) => c.churnDate);
  const { data: existing, error } = await supabase
    .from("client_offboarding_actions")
    .select("client_abbr, churn_date")
    .in("client_abbr", abbrs)
    .in("churn_date", dates);
  if (error) throw new Error(`existing rows query: ${error.message}`);
  const seen = new Set((existing || []).map((r) => `${r.client_abbr}|${r.churn_date}`));

  const toInsert: {
    client_abbr: string;
    churn_date: string;
    status: OffboardingStatus;
    group_hint: number | null;
  }[] = [];
  for (const c of churned) {
    if (seen.has(`${c.clientAbbr}|${c.churnDate}`)) continue;
    const group = await getGroupForClientTag(c.clientAbbr);
    toInsert.push({
      client_abbr: c.clientAbbr,
      churn_date: c.churnDate,
      status: "pending",
      group_hint: group,
    });
  }

  if (toInsert.length > 0) {
    const { error: insertErr } = await supabase
      .from("client_offboarding_actions")
      .insert(toInsert);
    if (insertErr) throw new Error(`insert pending rows: ${insertErr.message}`);
  }

  return {
    scanned: churned.length,
    created: toInsert.length,
    alreadyTracked: churned.length - toInsert.length,
  };
}

// Find pending rows whose churn_date is strictly before today (PST) and
// execute the offboarding for each. Used by the 9 AM PST auto-fire cron.
export async function runAutoFireForOverdue(): Promise<{
  fired: { clientAbbr: string; churnDate: string; result: OffboardingResult }[];
  failed: { clientAbbr: string; churnDate: string; error: string }[];
}> {
  const supabase = getSupabaseAdmin();
  const today = todayPst();
  const { data, error } = await supabase
    .from("client_offboarding_actions")
    .select("client_abbr, churn_date")
    .eq("status", "pending")
    .lt("churn_date", today);
  if (error) throw new Error(`overdue query: ${error.message}`);

  const fired: { clientAbbr: string; churnDate: string; result: OffboardingResult }[] = [];
  const failed: { clientAbbr: string; churnDate: string; error: string }[] = [];

  for (const row of data || []) {
    try {
      const result = await executeClientOffboarding(row.client_abbr);
      await supabase
        .from("client_offboarding_actions")
        .update({
          status: "auto_fired",
          executed_at: new Date().toISOString(),
          result,
        })
        .eq("client_abbr", row.client_abbr)
        .eq("churn_date", row.churn_date);
      fired.push({ clientAbbr: row.client_abbr, churnDate: row.churn_date, result });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "auto-fire failed";
      await supabase
        .from("client_offboarding_actions")
        .update({
          status: "failed",
          executed_at: new Date().toISOString(),
          result: { errors: [msg] },
        })
        .eq("client_abbr", row.client_abbr)
        .eq("churn_date", row.churn_date);
      failed.push({ clientAbbr: row.client_abbr, churnDate: row.churn_date, error: msg });
    }
  }

  return { fired, failed };
}

/** Auto-retry offboardings that previously FAILED (Spencer's Loom: "it retries
 *  automatically for us… after the third retry fails we can force retry").
 *  Retries up to MAX_AUTO_RETRIES times; past that it leaves the row failed for
 *  a human to force-retry via the Offboard button (which already allows a
 *  failed row through). All offboarding steps are idempotent, so re-running is
 *  safe. `retry_count` column tracks attempts. */
const MAX_AUTO_RETRIES = 3;
export async function runRetryForFailed(): Promise<{
  recovered: { clientAbbr: string; churnDate: string }[];
  stillFailing: { clientAbbr: string; churnDate: string; attempts: number; needsForce: boolean }[];
}> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("client_offboarding_actions")
    .select("client_abbr, churn_date, retry_count")
    .eq("status", "failed");
  if (error) throw new Error(`failed-retry query: ${error.message}`);

  const recovered: { clientAbbr: string; churnDate: string }[] = [];
  const stillFailing: { clientAbbr: string; churnDate: string; attempts: number; needsForce: boolean }[] = [];

  for (const row of data || []) {
    const attempts = (row.retry_count ?? 0) + 1;
    if ((row.retry_count ?? 0) >= MAX_AUTO_RETRIES) {
      stillFailing.push({ clientAbbr: row.client_abbr, churnDate: row.churn_date, attempts: row.retry_count ?? 0, needsForce: true });
      continue; // exhausted auto-retries → wait for a human force-retry
    }
    try {
      const result = await executeClientOffboarding(row.client_abbr);
      await supabase
        .from("client_offboarding_actions")
        .update({ status: "confirmed", executed_at: new Date().toISOString(), result, retry_count: attempts })
        .eq("client_abbr", row.client_abbr)
        .eq("churn_date", row.churn_date);
      recovered.push({ clientAbbr: row.client_abbr, churnDate: row.churn_date });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "retry failed";
      await supabase
        .from("client_offboarding_actions")
        .update({ status: "failed", executed_at: new Date().toISOString(), result: { errors: [msg] }, retry_count: attempts })
        .eq("client_abbr", row.client_abbr)
        .eq("churn_date", row.churn_date);
      stillFailing.push({ clientAbbr: row.client_abbr, churnDate: row.churn_date, attempts, needsForce: attempts >= MAX_AUTO_RETRIES });
    }
  }
  return { recovered, stillFailing };
}
