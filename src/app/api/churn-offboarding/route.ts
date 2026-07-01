import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerSupabaseClient, getSupabaseAdmin } from "@/lib/supabase";
import { getClientTrackerData } from "@/lib/google-sheets";
import { executeClientOffboarding } from "@/lib/client-offboarding";

// Action route is admin-only via middleware (POSTs aren't in VIEWER_API_GETS).
// In-route admin re-check defends against a session that downgraded mid-flight.

export const maxDuration = 60;

interface OffboardingActionRow {
  client_abbr: string;
  churn_date: string;
  status: "pending" | "confirmed" | "skipped" | "auto_fired" | "failed";
  group_hint: number | null;
  decided_by: string | null;
  decided_at: string | null;
  executed_at: string | null;
  result: unknown;
  created_at: string;
}

function thirtyDaysAgoIsoDate(): string {
  const d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

export async function GET() {
  const supabase = getSupabaseAdmin();
  try {
    const { data, error } = await supabase
      .from("client_offboarding_actions")
      .select("*")
      .or(`status.eq.pending,churn_date.gte.${thirtyDaysAgoIsoDate()}`)
      .order("churn_date", { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Decorate with company name from the Client Tracker sheet (cached).
    const tracker = await getClientTrackerData().catch(() => []);
    const nameByAbbr = new Map<string, string>();
    for (const row of tracker) {
      const abbr = (row.clientAbbr || "").trim().toUpperCase();
      if (abbr) nameByAbbr.set(abbr, row.companyName || abbr);
    }

    const items = (data as OffboardingActionRow[]).map((r) => ({
      clientAbbr: r.client_abbr,
      companyName: nameByAbbr.get(r.client_abbr) || r.client_abbr,
      churnDate: r.churn_date,
      status: r.status,
      groupHint: r.group_hint,
      decidedBy: r.decided_by,
      decidedAt: r.decided_at,
      executedAt: r.executed_at,
      result: r.result,
      createdAt: r.created_at,
    }));

    return NextResponse.json({ items });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const cookieStore = await cookies();
    const supabaseAuth = createServerSupabaseClient(cookieStore);
    const { data: { user } } = await supabaseAuth.auth.getUser();
    const role = user?.app_metadata?.role || user?.user_metadata?.role;
    if (!user || role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const { clientAbbr, churnDate, decision, result: feResult, allowInsert, groupHint } = body as {
      clientAbbr?: string;
      churnDate?: string;
      decision?: "confirm" | "skip";
      // Optional: result built up by the FE walking the plan. When provided we
      // trust it and skip server-side re-execution (saves another ~30s sync).
      result?: unknown;
      // Ad-hoc offboardings from the Churned clients card don't have a
      // pending row yet — allow the route to insert one on the fly.
      allowInsert?: boolean;
      groupHint?: 1 | 2 | null;
    };
    if (!clientAbbr || !churnDate || !decision) {
      return NextResponse.json(
        { error: "clientAbbr, churnDate, decision are required" },
        { status: 400 },
      );
    }
    if (decision !== "confirm" && decision !== "skip") {
      return NextResponse.json({ error: "decision must be 'confirm' or 'skip'" }, { status: 400 });
    }

    const abbr = clientAbbr.trim().toUpperCase();
    const supabase = getSupabaseAdmin();

    // Look up the existing row so we know whether to insert or update, and
    // whether to allow the decision at all.
    //
    // Historic behavior: rejected any status !== "pending" — but the
    // offboarding workflow is *inherently retryable* (Bison/Supabase steps
    // are idempotent) and blocking retries at this record-decision step
    // meant a partial failure on the actual Bison work permanently locked
    // the row into a broken state. The Churned Clients "Offboard" button
    // would 409 with "already confirmed — cannot change" even though the
    // work never actually completed.
    //
    // New rule: only block if the row was explicitly `skipped` — the user
    // chose to skip that offboarding and we respect that hard-lock. For
    // pending / confirmed / auto_fired / failed, treat this POST as either
    // an initial decision or a retry and let it through. All the step-level
    // work is idempotent so re-running is safe.
    const { data: existing, error: lookupErr } = await supabase
      .from("client_offboarding_actions")
      .select("status")
      .eq("client_abbr", abbr)
      .eq("churn_date", churnDate)
      .maybeSingle();
    if (lookupErr) {
      return NextResponse.json({ error: lookupErr.message }, { status: 500 });
    }
    if (!existing) {
      // Ad-hoc path: no pending row exists yet (e.g. the user hit "Offboard"
      // straight from the Churned Clients card before the daily churn-check
      // cron enqueued it). Insert a new pending row so the standard flow can
      // continue and the confirm() branch below has something to update.
      if (!allowInsert) {
        return NextResponse.json({ error: "no pending offboarding for this client/date" }, { status: 404 });
      }
      const { error: insErr } = await supabase
        .from("client_offboarding_actions")
        .insert({
          client_abbr: abbr,
          churn_date: churnDate,
          status: "pending",
          group_hint: groupHint ?? null,
        });
      if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
    } else if (existing.status === "skipped") {
      return NextResponse.json(
        { error: "already skipped — undo skip first if you want to offboard" },
        { status: 409 },
      );
    }
    // else: pending / confirmed / auto_fired / failed → allow the decision
    // through (fresh confirm or retry). The row's decided_at / executed_at /
    // result get overwritten with the latest attempt below.

    const decidedAt = new Date().toISOString();
    const decidedBy = user.email || user.id;

    if (decision === "skip") {
      const { error: updErr } = await supabase
        .from("client_offboarding_actions")
        .update({ status: "skipped", decided_by: decidedBy, decided_at: decidedAt })
        .eq("client_abbr", abbr)
        .eq("churn_date", churnDate);
      if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
      return NextResponse.json({ status: "skipped" });
    }

    // decision === "confirm" — either trust the FE's result (preferred — the
    // dashboard walks the plan step-by-step for live progress) or run the full
    // executor synchronously as a fallback (legacy curl callers, no FE).
    let result: unknown = feResult ?? null;
    if (!result) {
      try {
        result = await executeClientOffboarding(abbr);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "execution failed";
        await supabase
          .from("client_offboarding_actions")
          .update({
            status: "failed",
            decided_by: decidedBy,
            decided_at: decidedAt,
            executed_at: new Date().toISOString(),
            result: { errors: [msg] },
          })
          .eq("client_abbr", abbr)
          .eq("churn_date", churnDate);
        return NextResponse.json({ status: "failed", error: msg }, { status: 500 });
      }
    }

    const { error: updErr } = await supabase
      .from("client_offboarding_actions")
      .update({
        status: "confirmed",
        decided_by: decidedBy,
        decided_at: decidedAt,
        executed_at: new Date().toISOString(),
        result,
      })
      .eq("client_abbr", abbr)
      .eq("churn_date", churnDate);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    return NextResponse.json({ status: "confirmed", result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
