import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { postSlackMessage } from "@/lib/slack";
import { TRIAGE_NEEDS } from "@/lib/constants";

// Shared triage status for the "Clients without meeting-ready leads (4+ days)"
// panel. Status is per client tag (shared across users), one of:
//   unreviewed | in_progress | resolved
// Plus `needs`: a multi-select of what the client needs (see TRIAGE_NEEDS).
// Table: client_triage_status (client_tag PK, status, needs text[], updated_by, updated_at)

const VALID = new Set(["unreviewed", "in_progress", "resolved"]);
const VALID_NEEDS = new Set<string>(TRIAGE_NEEDS);

// GET ?tags=A,B,C  → { statuses: { TAG: { status, updated_by, updated_at } } }
// Also AUTO-RESETS: any stored tag NOT in the current panel set is deleted, so a
// client that dropped off the panel (got a lead) starts fresh if it returns.
export async function GET(request: Request) {
  try {
    const supabase = getSupabaseAdmin();
    const { searchParams } = new URL(request.url);

    // Only prune when the caller explicitly passes the current panel set.
    if (searchParams.has("tags")) {
      const tags = (searchParams.get("tags") || "")
        .split(",").map((t) => t.trim()).filter(Boolean);
      if (tags.length > 0) {
        // Delete rows for tags no longer on the panel.
        const { data: existing } = await supabase.from("client_triage_status").select("client_tag");
        const stale = (existing || []).map((r) => r.client_tag).filter((t: string) => !tags.includes(t));
        if (stale.length > 0) {
          await supabase.from("client_triage_status").delete().in("client_tag", stale);
        }
      } else {
        // Panel is empty → everyone got a lead → reset all.
        await supabase.from("client_triage_status").delete().neq("client_tag", "");
      }
    }

    const { data, error } = await supabase
      .from("client_triage_status")
      .select("client_tag, status, needs, resolve_reason, resolve_fixed, updated_by, updated_at");
    if (error) throw new Error(error.message);

    const statuses: Record<string, { status: string; needs: string[]; resolve_reason: string | null; resolve_fixed: string | null; updated_by: string | null; updated_at: string }> = {};
    for (const r of data || []) {
      statuses[r.client_tag] = { status: r.status, needs: r.needs || [], resolve_reason: r.resolve_reason ?? null, resolve_fixed: r.resolve_fixed ?? null, updated_by: r.updated_by, updated_at: r.updated_at };
    }
    return NextResponse.json({ statuses });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST { clientTag, status?, needs?, updatedBy } → upsert; posts to Slack on
// "resolved". `status` and `needs` are each optional but at least one is
// required — a status-only update leaves needs untouched and vice versa.
export async function POST(request: Request) {
  try {
    const supabase = getSupabaseAdmin();
    const { clientTag, status, needs, reason, fixed, updatedBy } = (await request.json()) as {
      clientTag?: string; status?: string; needs?: string[]; reason?: string; fixed?: string; updatedBy?: string;
    };
    if (!clientTag) {
      return NextResponse.json({ error: "clientTag is required" }, { status: 400 });
    }
    if (status !== undefined && !VALID.has(status)) {
      return NextResponse.json({ error: "invalid status" }, { status: 400 });
    }
    if (needs !== undefined && (!Array.isArray(needs) || needs.some((n) => !VALID_NEEDS.has(n)))) {
      return NextResponse.json({ error: "invalid needs" }, { status: 400 });
    }
    if (status === undefined && needs === undefined) {
      return NextResponse.json({ error: "nothing to update — provide status and/or needs" }, { status: 400 });
    }

    const now = new Date().toISOString();
    // Only include the columns being changed so a needs-only update doesn't
    // clobber status (and vice versa); the upsert leaves untouched columns as-is.
    const payload: Record<string, unknown> = {
      client_tag: clientTag, updated_by: updatedBy || null, updated_at: now,
    };
    if (status !== undefined) payload.status = status;
    if (needs !== undefined) payload.needs = [...new Set(needs)];
    // The diagnosis (reason for low performance + what was fixed) is captured
    // when a client is marked resolved. Trim to null so blanks don't store "".
    const cleanReason = typeof reason === "string" ? reason.trim() || null : undefined;
    const cleanFixed = typeof fixed === "string" ? fixed.trim() || null : undefined;
    if (status === "resolved") {
      payload.resolve_reason = cleanReason ?? null;
      payload.resolve_fixed = cleanFixed ?? null;
    }

    const { error } = await supabase
      .from("client_triage_status")
      .upsert(payload, { onConflict: "client_tag" });
    if (error) throw new Error(error.message);

    const ts = new Date().toLocaleString("en-US", {
      timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "short",
    });
    const by = updatedBy || "a teammate";
    // Triage notifications (complete + needs edits) go to the "lead sync
    // outbound" channel. Set SLACK_LEAD_SYNC_CHANNEL_ID to it; if unset we fall
    // back to SLACK_TRIAGE_CHANNEL_ID (postSlackMessage's default).
    const channel = process.env.SLACK_LEAD_SYNC_CHANNEL_ID;
    let slack: { ok: boolean; reason?: string } | undefined;
    if (status === "resolved") {
      // One consolidated message: what the client needed, the reason it was
      // flagged for low performance, and what was fixed. Each line only shows
      // when the operator provided it.
      const needList = (payload.needs as string[] | undefined) || [];
      const lines = [`✅ *${clientTag}* has been diagnosed and resolved by ${by} — ${ts} PST`];
      if (needList.length) lines.push(`   • *Needs:* ${needList.join(", ")}`);
      if (cleanReason) lines.push(`   • *Reason:* ${cleanReason}`);
      if (cleanFixed) lines.push(`   • *Fixed / detail:* ${cleanFixed}`);
      slack = await postSlackMessage(lines.join("\n"), channel);
    } else if (needs !== undefined) {
      // Needs changed outside of a resolve (kept for the API's older callers).
      const list = (payload.needs as string[]);
      const msg = list.length
        ? `📋 *${clientTag}* needs updated → *${list.join(", ")}* (by ${by} — ${ts} PST)`
        : `📋 *${clientTag}* needs cleared (by ${by} — ${ts} PST)`;
      slack = await postSlackMessage(msg, channel);
    }
    return NextResponse.json({ ok: true, slack });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
