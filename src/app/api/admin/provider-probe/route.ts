import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerSupabaseClient } from "@/lib/supabase";

// One-shot diagnostic: hits Inboxing + MilkBox + ScaledMail list endpoints
// and returns enough of the raw response to verify what's actually coming
// back — total counts, status distribution, sample rows, and any errors.
// Admin-only. `?only=scaledmail` (or inboxing/milkbox) probes one provider
// without burning the others' rate limits.
//
// We DON'T route through our lib helpers here — we call the providers with
// raw fetch so we can see the RAW paginated response shape (including any
// pagination metadata the lib might be dropping).

export const maxDuration = 60;

interface ProbeResult {
  inboxing?: unknown;
  milkbox?: unknown;
  scaledmail?: unknown;
}

async function inboxingProbe() {
  const key = process.env.INBOXING_API_KEY;
  const base = process.env.INBOXING_BASE_URL || "https://v2.inboxing.com/api/v2";
  if (!key) return { error: "INBOXING_API_KEY not set" };

  const pageSize = 100;
  const pages: Array<{
    page: number;
    http_status: number;
    row_count: number;
    status_counts: Record<string, number>;
    first_row_keys: string[];
    first_row_sample: unknown;
    top_level_keys: string[];
    pagination_hint: unknown;
  }> = [];

  const allStatusCounts: Record<string, number> = {};
  let totalRows = 0;

  for (let page = 1; page <= 5; page++) {
    const res = await fetch(`${base}/domains?per_page=${pageSize}&page=${page}`, {
      headers: { Accept: "application/json", "X-API-Key": key },
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }
    const obj = (json && typeof json === "object") ? json as Record<string, unknown> : {};
    const data = Array.isArray(obj.data) ? obj.data as Array<Record<string, unknown>> : [];
    const statusCounts: Record<string, number> = {};
    for (const row of data) {
      const s = String((row as { status?: unknown }).status ?? "");
      statusCounts[s] = (statusCounts[s] ?? 0) + 1;
      allStatusCounts[s] = (allStatusCounts[s] ?? 0) + 1;
    }
    totalRows += data.length;
    const firstRow = data[0] ?? null;
    pages.push({
      page,
      http_status: res.status,
      row_count: data.length,
      status_counts: statusCounts,
      first_row_keys: firstRow ? Object.keys(firstRow) : [],
      first_row_sample: firstRow,
      top_level_keys: Object.keys(obj),
      pagination_hint: obj.meta ?? obj.pagination ?? obj.links ?? null,
    });
    if (!res.ok) break;
    if (data.length < pageSize) break; // last page
  }

  return {
    total_rows_first_5_pages: totalRows,
    status_counts: allStatusCounts,
    pages,
  };
}

async function milkboxProbe() {
  const key = process.env.MILKBOX_API_KEY;
  const base = "https://api.milkboxmail.com/api/v1";
  if (!key) return { error: "MILKBOX_API_KEY not set" };

  const pages: Array<{
    page_index: number;
    http_status: number;
    row_count: number;
    status_counts: Record<string, number>;
    active_counts: Record<string, number>;
    first_row_keys: string[];
    first_row_sample: unknown;
    top_level_keys: string[];
    next_cursor: unknown;
  }> = [];
  let cursor: string | null = null;
  const allStatusCounts: Record<string, number> = {};
  const allActiveCounts: Record<string, number> = {};
  let totalRows = 0;

  for (let i = 0; i < 5; i++) {
    const path = cursor ? `/domains?cursor=${encodeURIComponent(cursor)}` : `/domains`;
    const res = await fetch(`${base}${path}`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }
    const obj = (json && typeof json === "object") ? json as Record<string, unknown> : {};
    const data = Array.isArray(obj.data) ? obj.data as Array<Record<string, unknown>> : [];
    const statusCounts: Record<string, number> = {};
    const activeCounts: Record<string, number> = {};
    for (const row of data) {
      const s = String((row as { status?: unknown }).status ?? "");
      const a = String((row as { active?: unknown }).active ?? "");
      statusCounts[s] = (statusCounts[s] ?? 0) + 1;
      activeCounts[a] = (activeCounts[a] ?? 0) + 1;
      allStatusCounts[s] = (allStatusCounts[s] ?? 0) + 1;
      allActiveCounts[a] = (allActiveCounts[a] ?? 0) + 1;
    }
    totalRows += data.length;
    const firstRow = data[0] ?? null;
    const pagination = (obj.pagination && typeof obj.pagination === "object")
      ? obj.pagination as Record<string, unknown> : {};
    const nextCursor = (pagination.next_cursor ?? null) as string | null;
    pages.push({
      page_index: i,
      http_status: res.status,
      row_count: data.length,
      status_counts: statusCounts,
      active_counts: activeCounts,
      first_row_keys: firstRow ? Object.keys(firstRow) : [],
      first_row_sample: firstRow,
      top_level_keys: Object.keys(obj),
      next_cursor: nextCursor,
    });
    if (!res.ok) break;
    if (!nextCursor) break;
    cursor = nextCursor;
  }

  return {
    total_rows_first_5_pages: totalRows,
    status_counts: allStatusCounts,
    active_counts: allActiveCounts,
    pages,
  };
}

async function scaledmailProbe() {
  const key = process.env.SCALEDMAIL_API_KEY;
  const orgId = process.env.SCALEDMAIL_ORGANIZATION_ID;
  if (!key || !orgId) return { error: "SCALEDMAIL_API_KEY / SCALEDMAIL_ORGANIZATION_ID not set" };

  const url = new URL("https://server.scaledmail.com/api/v1/domains");
  url.searchParams.set("organization_id", orgId);
  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }

  // The docs don't document this response shape, so surface everything the
  // parser needs to be built against: envelope keys, where the array lives,
  // the first rows verbatim, and status distribution.
  const obj = (json && typeof json === "object" && !Array.isArray(json)) ? json as Record<string, unknown> : {};
  const arr: Array<Record<string, unknown>> = Array.isArray(json)
    ? json as Array<Record<string, unknown>>
    : Array.isArray(obj.domains) ? obj.domains as Array<Record<string, unknown>>
    : Array.isArray(obj.data) ? obj.data as Array<Record<string, unknown>>
    : [];
  const statusCounts: Record<string, number> = {};
  for (const row of arr) {
    const s = String((row as { status?: unknown }).status ?? "<no status field>");
    statusCounts[s] = (statusCounts[s] ?? 0) + 1;
  }
  return {
    http_status: res.status,
    is_json: json !== null,
    top_level_type: Array.isArray(json) ? "array" : typeof json,
    top_level_keys: Array.isArray(json) ? null : Object.keys(obj),
    row_count: arr.length,
    status_counts: statusCounts,
    first_row_keys: arr[0] ? Object.keys(arr[0]) : [],
    sample_rows: arr.slice(0, 3),
    raw_head: json === null ? text.slice(0, 1500) : undefined,
  };
}

export async function GET(request: Request) {
  const cookieStore = await cookies();
  const supabaseAuth = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabaseAuth.auth.getUser();
  const role = user?.app_metadata?.role || user?.user_metadata?.role;
  if (!user || role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const only = new URL(request.url).searchParams.get("only");
  const result: ProbeResult = {};
  if (!only || only === "inboxing") {
    try {
      result.inboxing = await inboxingProbe();
    } catch (e) {
      result.inboxing = { error: e instanceof Error ? e.message : "probe failed" };
    }
  }
  if (!only || only === "milkbox") {
    try {
      result.milkbox = await milkboxProbe();
    } catch (e) {
      result.milkbox = { error: e instanceof Error ? e.message : "probe failed" };
    }
  }
  if (!only || only === "scaledmail") {
    try {
      result.scaledmail = await scaledmailProbe();
    } catch (e) {
      result.scaledmail = { error: e instanceof Error ? e.message : "probe failed" };
    }
  }
  return NextResponse.json(result);
}
